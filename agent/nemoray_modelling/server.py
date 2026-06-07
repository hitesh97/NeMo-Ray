"""
FastAPI bridge — serves the Nemotron resilience agent over HTTP/SSE.

The deck.gl viewer's chat panel POSTs to `/agent` and renders the streamed
`AgentStreamEvent` frames (see `events.py`). The agent drives the coverage twin
over `TWIN_URL` and reasons with a local Nemotron over `NEMOTRON_BASE_URL`.

Run it (twin on :8000 and the NIM on :8080 first):

    TWIN_URL=http://localhost:8000 \
    NEMOTRON_BASE_URL=http://localhost:8080 \
    uvicorn nemoray_modelling.server:app --port 8001

CORS is open so the browser (served from the twin on :8000) can stream from here.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import iterate_in_threadpool

import httpx

from .agent import (
    NEMOTRON_BASE_URL,
    NEMOTRON_MODEL,
    LlamaCppPlanner,
    Planner,
    StubPlanner,
    run_agent,
)

app = FastAPI(title="NeMo-Ray Nemotron agent", version="0.2.0")

# The viewer is served from the twin (a different origin/port), so allow cross-origin
# fetch/SSE. This is a local demo tool; a wildcard origin is fine here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SiteDownTrigger(BaseModel):
    kind: str  # "site_down"
    siteId: str
    siteName: str


class Turn(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class AgentRequest(BaseModel):
    prompt: str | None = None
    trigger: SiteDownTrigger | None = None
    # Prior conversation turns so Nemotron can "track back" (bounded server-side).
    history: list[Turn] | None = None
    # Mast ids the operator clicked on the map (multi-select targets for the action).
    selected_site_ids: list[str] | None = None
    # Active HUD scenario id (e.g. "infrastructure-loss") — selects the pre-rendered outage
    # when the operator hasn't picked specific masts.
    scenario: str | None = None


def _event_text(body: AgentRequest) -> str:
    """Turn the request into the plain-English event the agent reasons over."""
    if body.trigger and body.trigger.kind == "site_down":
        base = (f"ESN site {body.trigger.siteId} ({body.trigger.siteName}) has gone "
                f"offline. Assess the coverage lost and recommend where to deploy a COW.")
    else:
        base = body.prompt or "Give me a status assessment of the network."
    if body.selected_site_ids:
        # Make the operator's map selection actionable: name the exact site ids so the
        # model passes them to simulate_outage / move_mast instead of guessing.
        base += ("\n\n[Operator has selected these mast ids on the map: "
                 + ", ".join(body.selected_site_ids) + "]")
    if body.scenario and body.scenario != "live":
        # Operational context: simulate_outage with no ids uses this scenario's outage.
        base += f"\n\n[Active scenario: {body.scenario}]"
    return base


def _nim_reachable(base_url: str) -> bool:
    try:
        r = httpx.get(f"{base_url.rstrip('/')}/v1/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


def _make_planner(selected: list[str] | None = None, scenario: str | None = None) -> Planner:
    """Pick the planner. AGENT_LLM = nim | stub | auto (default).
    `auto` uses the NIM when its /v1/models is reachable, else the offline stub."""
    mode = os.getenv("AGENT_LLM", "auto").strip().lower()
    base_url = os.getenv("NEMOTRON_BASE_URL", NEMOTRON_BASE_URL)
    if mode == "stub":
        return StubPlanner(selected_site_ids=selected, scenario=scenario)
    if mode == "nim" or (mode == "auto" and _nim_reachable(base_url)):
        return LlamaCppPlanner(base_url=base_url,
                               model=os.getenv("NEMOTRON_MODEL", NEMOTRON_MODEL))
    return StubPlanner(selected_site_ids=selected, scenario=scenario)


def _sse(frames: Iterator[dict[str, Any]]) -> Iterator[str]:
    for frame in frames:
        yield f"data: {json.dumps(frame)}\n\n"


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "nemotron_base_url": os.getenv("NEMOTRON_BASE_URL", NEMOTRON_BASE_URL),
        "nemotron_model": os.getenv("NEMOTRON_MODEL", NEMOTRON_MODEL),
        "twin_url": os.getenv("TWIN_URL", ""),
    }


def _gpu_snapshot() -> dict[str, Any]:
    """Sample the DGX Spark GPU (device, memory, utilisation) for the HUD Stats board.

    Tries NVML (precise) first, then falls back to parsing `nvidia-smi`. Returns `None`
    fields with `source="unavailable"` when neither works (no GPU / driver) — the HUD then
    shows em-dashes rather than a fabricated figure. On the Spark's unified memory the
    figures are whole-device (the box runs the twin + Nemotron together), which is what we
    want to surface as "GPU memory in use".
    """
    # 1) NVML (pynvml) — exact bytes + name straight from the driver.
    try:
        import pynvml  # type: ignore

        pynvml.nvmlInit()
        try:
            h = pynvml.nvmlDeviceGetHandleByIndex(0)
            mem = pynvml.nvmlDeviceGetMemoryInfo(h)
            util = pynvml.nvmlDeviceGetUtilizationRates(h)
            name = pynvml.nvmlDeviceGetName(h)
            if isinstance(name, bytes):
                name = name.decode()
            return {
                "device": name,
                "vram_used_mib": round(mem.used / 1024 / 1024),
                "vram_total_mib": round(mem.total / 1024 / 1024),
                "gpu_util_pct": int(util.gpu),
                "source": "nvml",
            }
        finally:
            pynvml.nvmlShutdown()
    except Exception:  # noqa: BLE001 — fall through to nvidia-smi
        pass

    # 2) nvidia-smi — parse the CSV query.
    try:
        import subprocess

        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3.0,
        )
        if out.returncode == 0 and out.stdout.strip():
            name, used, total, util = (c.strip() for c in out.stdout.strip().splitlines()[0].split(","))
            return {
                "device": name,
                "vram_used_mib": int(float(used)),
                "vram_total_mib": int(float(total)),
                "gpu_util_pct": int(float(util)),
                "source": "nvidia-smi",
            }
    except Exception:  # noqa: BLE001 — report unavailable below
        pass

    return {
        "device": None,
        "vram_used_mib": None,
        "vram_total_mib": None,
        "gpu_util_pct": None,
        "source": "unavailable",
    }


@app.get("/gpu")
def gpu() -> dict[str, Any]:
    """Live Nemotron inference telemetry for the HUD Stats board: the served model plus a
    DGX Spark GPU snapshot (VRAM used / total, utilisation). The output-token rate is
    measured on the HUD side from the SSE stream, so it isn't reported here."""
    snap = _gpu_snapshot()
    snap["model"] = os.getenv("NEMOTRON_MODEL", NEMOTRON_MODEL)
    return snap


_SAT_CACHE: dict[str, Any] = {"ts": None, "sats": None}


def _starlink_constellation():
    """Load + parse the Starlink TLEs once and reuse across requests (≈7k satellites)."""
    if _SAT_CACHE["sats"] is None:
        from skyfield.api import load
        from . import tle
        _SAT_CACHE["ts"] = load.timescale()
        _SAT_CACHE["sats"] = tle.load_starlink_tles(ts=_SAT_CACHE["ts"])
    return _SAT_CACHE["ts"], _SAT_CACHE["sats"]


@app.get("/starlink_track")
def starlink_track(lat: float, lng: float, minutes: int = 12, step_s: int = 15) -> dict[str, Any]:
    """Propagate the Starlink constellation over a window and return, at each step, the BEST
    visible satellite from (lat,lng) — so the viewer can animate the COW's uplink following
    the satellite across the sky and HANDING OVER to the next one as each passes below the
    horizon. Each sample has the satellite's azimuth/elevation (for a local sky-dome render),
    its sub-point, slant range, and a `handover` flag. Falls back to a small synthetic arc if
    Skyfield/TLEs are unavailable so the demo still animates."""
    from datetime import UTC, datetime, timedelta

    samples: list[dict[str, Any]] = []
    try:
        from .starlink import visible_satellites
        ts, sats = _starlink_constellation()        # cached across requests
        start = datetime.now(UTC)
        mask = 25.0
        current = None                          # the satellite we're currently locked onto
        n = max(1, int(minutes * 60 / step_s))
        for k in range(n):
            when = start + timedelta(seconds=k * step_s)
            views = visible_satellites(lat, lng, when, min_elevation_deg=mask, tles=sats, ts=ts)
            if not views:
                current = None
                continue
            # Sticky handover: keep the locked satellite while it stays above the mask;
            # only switch (handover) when it sets, then grab the highest one available.
            held = next((x for x in views if x.name == current), None)
            handover = False
            if held is not None:
                v = held
            else:
                v = max(views, key=lambda x: x.elevation_deg)
                handover = current is not None
                current = v.name
            samples.append({
                "t": k * step_s, "satellite": v.name,
                "elevation_deg": round(v.elevation_deg, 1), "azimuth_deg": round(v.azimuth_deg, 1),
                "slant_range_km": round(v.slant_range_km, 1),
                "sat_lat": round(v.sat_lat, 4), "sat_lon": round(v.sat_lon, 4),
                "handover": handover,
            })
        if samples:
            names = []
            for s in samples:
                if not names or names[-1] != s["satellite"]:
                    names.append(s["satellite"])
            return {"source": "skyfield", "cow": {"lat": lat, "lng": lng},
                    "step_s": step_s, "samples": samples,
                    "satellites": names, "handovers": sum(s["handover"] for s in samples)}
    except Exception:  # noqa: BLE001 — synthetic fallback below
        pass

    # Fallback: a couple of synthetic passes so the link still animates without Skyfield.
    import math
    samples = []                    # discard any partial real samples from a mid-loop failure
    for k in range(48):
        frac = (k % 24) / 24.0
        az = (frac * 180 + (180 if k >= 24 else 0)) % 360
        el = 80 * math.sin(math.pi * frac) + 8
        samples.append({"t": k * step_s, "satellite": f"STARLINK-{1000 + k // 24}",
                        "elevation_deg": round(el, 1), "azimuth_deg": round(az, 1),
                        "slant_range_km": round(2000 - 1400 * math.sin(math.pi * frac), 1),
                        "sat_lat": lat, "sat_lon": lng, "handover": k == 24})
    return {"source": "fixture", "cow": {"lat": lat, "lng": lng}, "step_s": step_s,
            "samples": samples, "satellites": ["STARLINK-1000", "STARLINK-1001"], "handovers": 1}


@app.post("/agent")
def agent(body: AgentRequest) -> StreamingResponse:
    """Stream the agent run as Server-Sent Events of `AgentStreamEvent` frames."""
    history = [t.model_dump() for t in body.history] if body.history else None
    planner = _make_planner(body.selected_site_ids, body.scenario)
    frames = run_agent(_event_text(body), planner=planner, history=history)
    # The agent generator does blocking I/O (httpx) in live mode; run it in a
    # threadpool so it doesn't stall the event loop.
    return StreamingResponse(
        iterate_in_threadpool(_sse(frames)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )

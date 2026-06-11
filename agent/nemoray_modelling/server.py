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

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import iterate_in_threadpool

from .agent import (
    NEMOTRON_BASE_URL,
    NEMOTRON_MODEL,
    LlamaCppPlanner,
    Planner,
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


def _make_planner() -> Planner:
    """The Nemotron Super NVFP4 planner (local vLLM NIM). If the NIM is down, the
    run surfaces a clear planner error frame in the HUD console — no scripted stand-in."""
    return LlamaCppPlanner(
        base_url=os.getenv("NEMOTRON_BASE_URL", NEMOTRON_BASE_URL),
        model=os.getenv("NEMOTRON_MODEL", NEMOTRON_MODEL),
    )


def _sse(frames: Iterator[dict[str, Any]]) -> Iterator[str]:
    for frame in frames:
        yield f"data: {json.dumps(frame)}\n\n"


@app.get("/health")
def health() -> dict[str, Any]:
    base_url = os.getenv("NEMOTRON_BASE_URL", NEMOTRON_BASE_URL)
    return {
        "status": "ok",
        "nemotron_base_url": base_url,
        "nemotron_model": os.getenv("NEMOTRON_MODEL", NEMOTRON_MODEL),
        "nemotron_reachable": _nim_reachable(base_url),
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


@app.post("/agent")
def agent(body: AgentRequest) -> StreamingResponse:
    """Stream the agent run as Server-Sent Events of `AgentStreamEvent` frames."""
    history = [t.model_dump() for t in body.history] if body.history else None
    planner = _make_planner()
    frames = run_agent(_event_text(body), planner=planner, history=history)
    # The agent generator does blocking I/O (httpx) in live mode; run it in a
    # threadpool so it doesn't stall the event loop.
    return StreamingResponse(
        iterate_in_threadpool(_sse(frames)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )

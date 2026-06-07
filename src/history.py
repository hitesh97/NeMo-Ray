"""Sim-state snapshots for one-click revert.

Each change the agent makes (a coverage re-sim or an optimisation) snapshots the small
web artifacts in out/ into out/.history/<id>/. The viewer lists them and can restore any
one — the "revert to a previous sim state" the operator asked for. Kept on disk (not in
memory) and capped to a ring buffer, so it stays light on the DGX.

The large out/paths.geojson is intentionally NOT snapshotted (it's regenerated on demand);
out/new_rays.geojson (the affected-tile rays) is small and IS snapshotted.
"""
from __future__ import annotations

import json
import os
import shutil
import time

# Small artifacts that define a viewable sim state.
SNAP_FILES = [
    "coverage.png", "coverage_bounds.json", "hotspots.geojson", "new_rays.geojson",
    "new_masts.geojson", "optimization.json", "verification.json", "summary.json",
]
CAP = 15


def _hdir(cfg) -> str:
    return os.path.join(cfg["paths"]["out_dir"], ".history")


def snapshot(cfg, label: str, extra: dict | None = None, cap: int = CAP) -> dict:
    """Copy the current out/ artifacts into a new snapshot; return its meta."""
    out = cfg["paths"]["out_dir"]
    hd = _hdir(cfg)
    os.makedirs(hd, exist_ok=True)
    sid = f"{int(time.time() * 1000)}"
    dest = os.path.join(hd, sid)
    os.makedirs(dest, exist_ok=True)
    for f in SNAP_FILES:
        p = os.path.join(out, f)
        if os.path.exists(p):
            shutil.copy2(p, os.path.join(dest, f))
    meta = {"id": sid, "label": label, "ts": time.time()}
    if extra:
        meta.update(extra)
    with open(os.path.join(dest, "meta.json"), "w") as fh:
        json.dump(meta, fh)
    _prune(cfg, cap)
    return meta


def list_states(cfg) -> list[dict]:
    hd = _hdir(cfg)
    if not os.path.isdir(hd):
        return []
    out = []
    for sid in os.listdir(hd):
        m = os.path.join(hd, sid, "meta.json")
        if os.path.isfile(m):
            try:
                with open(m) as fh:
                    out.append(json.load(fh))
            except (json.JSONDecodeError, OSError):
                continue
    return sorted(out, key=lambda s: s.get("ts", 0))


def restore(cfg, sid: str) -> dict:
    """Copy a snapshot's artifacts back into out/. Returns the restored meta."""
    src = os.path.join(_hdir(cfg), str(sid))
    if not os.path.isdir(src):
        raise FileNotFoundError(f"no snapshot {sid}")
    out = cfg["paths"]["out_dir"]
    for f in SNAP_FILES:
        p = os.path.join(src, f)
        if os.path.exists(p):
            shutil.copy2(p, os.path.join(out, f))
    meta_path = os.path.join(src, "meta.json")
    with open(meta_path) as fh:
        return json.load(fh)


def ensure_baseline(cfg) -> None:
    """Snapshot the current state as 'baseline' if no history exists yet, recording its
    served % / gap count (from summary.json) so a revert to baseline restores the KPIs."""
    if list_states(cfg):
        return
    extra = {}
    try:
        with open(os.path.join(cfg["paths"]["out_dir"], "summary.json")) as f:
            s = json.load(f)
        extra = {"served_pct": round(s.get("served_pct"), 2) if s.get("served_pct") is not None else None,
                 "coverage_holes": s.get("low_coverage_polys")}
    except (OSError, ValueError, TypeError):
        pass
    snapshot(cfg, "baseline", extra=extra)


def _prune(cfg, cap: int) -> None:
    states = list_states(cfg)
    for s in states[:-cap] if len(states) > cap else []:
        shutil.rmtree(os.path.join(_hdir(cfg), s["id"]), ignore_errors=True)

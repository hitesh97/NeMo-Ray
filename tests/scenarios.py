"""Exhaustive agent tool sweep against the RUNNING twin (:8000).

Run in the AGENT venv (has httpx + skyfield + the package):
    TWIN_URL=http://localhost:8000 PYTHONPATH=agent agent/.venv/bin/python -m tests.scenarios

Checks, for every resilience tool: the right backend answers, observations have the
expected shape, and — critically — that each network change RE-TRACES rays
(out/new_rays.geojson is non-empty). The agent loop itself (planner → tools) is
exercised by tests/integration_nim.py against the live Nemotron NIM.
"""
from __future__ import annotations

import os
import time

import httpx

os.environ.setdefault("TWIN_URL", "http://localhost:8000")
TWIN = os.environ["TWIN_URL"].rstrip("/")

from nemoray_modelling.tools import ToolRegistry  # noqa: E402

IDS = ["TQ3461880911", "TQ3460081200", "TQ3460081260"]       # real central-London EE masts
PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""))


def rays() -> int:
    try:
        return len(httpx.get(f"{TWIN}/out/new_rays.geojson", timeout=15).json().get("features", []))
    except Exception:
        return -1


def reset_rays():
    """Blank new_rays so the next 'rays recomputed' check is meaningful."""
    try:
        httpx.post(f"{TWIN}/api/rays", json={"disabled_site_ids": ["__none__"], "added": [],
                                             "affected_only": True}, timeout=120)
    except Exception:
        pass


def main() -> int:
    print("\n=== 1. simulate_outage (real masts) ===")
    reg = ToolRegistry()
    t0 = time.time(); r = reg.run("simulate_outage", {"site_ids": IDS})
    o = r.observation
    check("source = real twin", o.get("source") == "Sionna RT coverage twin", o.get("source"))
    check("reports affected buildings", "affected_counts" in o, str(o.get("affected_counts")))
    check("served_pct present", o.get("served_pct") is not None, str(o.get("served_pct")))
    check("rays recomputed", rays() > 0, f"{rays()} rays, {time.time()-t0:.0f}s")

    print("\n=== 2. simulate_outage (no ids) → default scenario outage, real twin ===")
    r = reg.run("simulate_outage", {"site_ids": []})
    o = r.observation
    check("default outage resolves masts", bool(o.get("disabled_cells")), str(o.get("disabled_cells")))
    check("default outage real source", o.get("source") == "Sionna RT coverage twin", o.get("source"))

    print("\n=== 3. move_mast ===")
    reset_rays()
    r = reg.run("move_mast", {"site_id": IDS[0], "new_lat": 51.515, "new_lng": -0.075})
    check("move source twin", r.observation.get("source") == "Sionna RT coverage twin", r.observation.get("source"))
    check("move rays recomputed", rays() > 0, f"{rays()} rays")

    print("\n=== 4. move_mast (missing args) → graceful error ===")
    r = reg.run("move_mast", {"site_id": IDS[0]})
    check("move missing-args handled", "error" in r.observation, r.result[:50])

    print("\n=== 5. deploy_cow ===")
    reset_rays()
    t0 = time.time(); r = reg.run("deploy_cow", {"disabled_site_ids": IDS})
    o = r.observation
    check("cow placed", bool(o.get("cow")), str(o.get("cow")))
    check("depot is a fire station", "Fire Station" in (o.get("source_station", {}) or {}).get("name", ""),
          (o.get("source_station") or {}).get("name"))
    check("buildings protected > 0", (o.get("buildings_protected") or 0) > 0, str(o.get("buildings_protected")))
    check("hole closure verified by twin", bool(o.get("verified")), str(o.get("verified")))
    check("deploy rays recomputed", rays() > 0, f"{rays()} rays, {time.time()-t0:.0f}s")

    print("\n=== 6. check_starlink (after COW) — live Skyfield ===")
    r = reg.run("check_starlink", {})
    o = r.observation
    check("starlink real source", o.get("source") == "Skyfield (Starlink TLEs)", o.get("source"))
    check("satellite or honest empty-sky", "satellite" in o, str(o.get("satellite")))

    print("\n=== 7. check_starlink (no COW, no coords) → graceful ===")
    r2 = ToolRegistry().run("check_starlink", {})
    check("starlink no-context handled", "error" in r2.observation, r2.result[:50])

    print("\n=== 8. validate_site — real EA LiDAR (WCS auto-fetch) ===")
    r = reg.run("validate_site", {"candidate_id": "sweep-1", "lat": 51.5045, "lng": -0.0900})
    o = r.observation
    check("lidar verdict is real or honest-unknown",
          (o.get("source") == "EA-LiDAR (overshadowing)" and o.get("verdict") in ("pass", "fail"))
          or o.get("verdict") == "unknown",
          f"{o.get('verdict')} via {o.get('source')}")

    print("\n=== 9. run_cuopt (via twin) ===")
    t0 = time.time(); r = reg.run("run_cuopt", {"dead_zone_ids": []})
    o = r.observation
    check("cuopt produced candidates", (o.get("candidate_count") or 0) > 0,
          f"{o.get('candidate_count')} in {time.time()-t0:.0f}s")
    check("cuopt source named", o.get("source", "").startswith(("cuOpt", "cuOpt output")), o.get("source"))

    print("\n=== 10. knowledge graph quick checks ===")
    r = reg.run("locate_place", {"query": "tower bridge"})
    check("locate_place resolves", r.observation.get("source") == "knowledge-graph", r.result[:50])
    r = reg.run("find_nearest", {"kind": "fire", "lat": 51.5045, "lng": -0.09})
    check("find_nearest answers", bool(r.observation.get("name")), r.result[:60])

    print(f"\n=== RESULT: {len(PASS)} passed, {len(FAIL)} failed ===")
    if FAIL:
        print("FAILED:", FAIL)
    # restore baseline so the demo starts clean
    try:
        states = httpx.get(f"{TWIN}/api/history", timeout=10).json()["states"]
        httpx.post(f"{TWIN}/api/restore", json={"id": states[0]["id"]}, timeout=30)
        print("(restored baseline)")
    except Exception as e:
        print("(could not restore baseline:", e, ")")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())

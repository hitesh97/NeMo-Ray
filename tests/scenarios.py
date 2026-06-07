"""Exhaustive agent scenario sweep against the RUNNING twin (:8000).

Run in the AGENT venv (has httpx + skyfield + the package):
    TWIN_URL=http://localhost:8000 PYTHONPATH=. agent/.venv/bin/python -m tests.scenarios
(or from agent/: TWIN_URL=... .venv/bin/python -m ... )

Checks, for every scenario: the right tools fire, observations have the expected shape, and
— critically — that each network change RE-TRACES rays (out/new_rays.geojson is non-empty).
"""
from __future__ import annotations

import os
import time

import httpx

os.environ.setdefault("TWIN_URL", "http://localhost:8000")
os.environ.setdefault("AGENT_LLM", "stub")
TWIN = os.environ["TWIN_URL"].rstrip("/")

from nemoray_modelling import StubPlanner, run_agent          # noqa: E402
from nemoray_modelling.tools import ToolRegistry              # noqa: E402

IDS = ["TQ3461880911", "TQ3460081200", "TQ3460081260"]       # real central-London EE masts
PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""))


def rays() -> int:
    try:
        return len(httpx.get(f"{TWIN}/out/new_rays.geojson", timeout=15).json().get("features", []))
    except Exception as e:
        return -1


def reset_rays():
    """Blank new_rays so the next 'rays recomputed' check is meaningful."""
    try:
        httpx.post(f"{TWIN}/api/rays", json={"disabled_site_ids": ["__none__"], "added": [],
                                             "affected_only": True}, timeout=120)
    except Exception:
        pass


def run_flow(prompt, selected=None):
    frames = list(run_agent(prompt, planner=StubPlanner(selected_site_ids=selected)))
    tools = [f["call"]["name"] for f in frames if f["type"] == "tool_call"]
    final = "".join(f.get("text", "") for f in frames if f["type"] == "token")
    err = [f["message"] for f in frames if f["type"] == "error"]
    return tools, final, err


def main() -> int:
    print("\n=== 1. simulate_outage (real masts) ===")
    reg = ToolRegistry()
    t0 = time.time(); r = reg.run("simulate_outage", {"site_ids": IDS})
    o = r.observation
    check("source = real twin", o.get("source") == "Sionna RT coverage twin", o.get("source"))
    check("reports affected buildings", "affected_counts" in o, str(o.get("affected_counts")))
    check("served_pct present", o.get("served_pct") is not None, str(o.get("served_pct")))
    check("rays recomputed", rays() > 0, f"{rays()} rays, {time.time()-t0:.0f}s")

    print("\n=== 2. simulate_outage (empty ids) → fixture, no crash ===")
    r = reg.run("simulate_outage", {"site_ids": []})
    check("empty outage = fixture", r.observation.get("source") == "fixture", r.observation.get("source"))

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
    check("deploy rays recomputed", rays() > 0, f"{rays()} rays, {time.time()-t0:.0f}s")

    print("\n=== 6. check_starlink (after COW) ===")
    r = reg.run("check_starlink", {})
    o = r.observation
    check("satellite identified", bool(o.get("satellite")), str(o.get("satellite")))
    check("starlink source", o.get("source") in ("Skyfield (Starlink TLEs)", "fixture"), o.get("source"))

    print("\n=== 7. check_starlink (no COW, no coords) → graceful ===")
    r2 = ToolRegistry().run("check_starlink", {})
    check("starlink no-context handled", "error" in r2.observation or r2.observation.get("satellite"), r2.result[:50])

    print("\n=== 8. STUB FLOW: outage → cow → starlink ===")
    tools, final, err = run_flow("simulate the selected masts going offline", selected=IDS)
    check("outage flow tools", tools[:1] == ["simulate_outage"], str(tools))
    check("outage flow no errors", not err, str(err))
    check("outage flow has final", len(final) > 20, final[:60])

    print("\n=== 9. STUB FLOW: deploy a cell-on-wheels ===")
    tools, final, err = run_flow("deploy a cell-on-wheels and check starlink")
    check("deploy flow runs deploy_cow", "deploy_cow" in tools, str(tools))
    check("deploy flow checks starlink", "check_starlink" in tools, str(tools))
    check("deploy flow final", len(final) > 20, final[:60])

    print("\n=== 10. STUB FLOW: optimise (cuOpt reject→retry→accept) ===")
    t0 = time.time(); tools, final, err = run_flow("optimise new mast placement to fix the gaps")
    check("optimise runs cuopt", "run_cuopt" in tools, str(tools))
    check("optimise validates", "validate_site" in tools, f"{tools} ({time.time()-t0:.0f}s)")
    check("optimise final", len(final) > 10, final[:60])

    print("\n=== 11. STUB FLOW: help / capabilities ===")
    tools, final, err = run_flow("what is this system and what can you do?")
    check("help fires no tools", tools == [], str(tools))
    check("help has real answer", "resilience" in final.lower() or "cell-on-wheels" in final.lower(), final[:60])

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

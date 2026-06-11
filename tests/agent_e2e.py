"""Comprehensive end-to-end conversational sweep of the LIVE agent stack.

Drives the real path the HUD uses — POST /agent on the SSE bridge (:8001) — with the
real Nemotron Super planner (:8080) and the real Sionna twin (:8000) behind it, across
every capability plus multi-turn follow-ups. Verifies: the right kind of tool fires,
observations come from real backends, map directives stream, finals are substantive,
and no error frames appear.

Run (all services up):
    PYTHONPATH=agent agent/.venv/bin/python -m tests.agent_e2e
"""
from __future__ import annotations

import json
import os
import sys
import time

import httpx

AGENT = os.environ.get("AGENT_URL", "http://localhost:8001").rstrip("/")
TWIN = os.environ.get("TWIN_URL", "http://localhost:8000").rstrip("/")
PASS: list[str] = []
FAIL: list[str] = []

# Real central-London EE masts (exist in masts.geojson).
MASTS = ["TQ3461880911", "TQ3460081200"]


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))


def run_turn(prompt: str, history: list[dict] | None = None,
             selected: list[str] | None = None, scenario: str | None = None,
             timeout: float = 900.0) -> dict:
    """One agent turn over SSE; returns tools fired, final text, map ops, errors."""
    body: dict = {"prompt": prompt}
    if history:
        body["history"] = history
    if selected:
        body["selected_site_ids"] = selected
    if scenario:
        body["scenario"] = scenario
    tools: list[str] = []
    finals: list[str] = []
    errors: list[str] = []
    ops: list[str] = []
    tool_results: dict[str, str] = {}
    id2name: dict[str, str] = {}
    t0 = time.time()
    with httpx.Client(timeout=httpx.Timeout(timeout, connect=10.0)) as c, \
         c.stream("POST", f"{AGENT}/agent", json=body) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line.startswith("data: "):
                continue
            f = json.loads(line[len("data: "):])
            t = f.get("type")
            if t == "tool_call":
                tools.append(f["call"]["name"])
                id2name[f["call"]["id"]] = f["call"]["name"]
            elif t == "tool_update" and f.get("patch", {}).get("status") == "success":
                name = id2name.get(f.get("id", ""), "?")
                tool_results[name] = str(f["patch"].get("result", ""))
            elif t == "token":
                finals.append(f.get("text", ""))
            elif t == "error":
                errors.append(f.get("message", ""))
            elif t == "map_action":
                ops.append(f.get("action", {}).get("op", "?"))
    return {"tools": tools, "final": "".join(finals).strip(), "errors": errors,
            "ops": ops, "results": tool_results, "secs": round(time.time() - t0, 1)}


def turn_pair(prompt: str, reply: str) -> list[dict]:
    return [{"role": "operator", "content": prompt}, {"role": "agent", "content": reply}]


def main() -> int:  # noqa: PLR0915 — a linear test script
    print(f"agent: {AGENT}   twin: {TWIN}")
    health = httpx.get(f"{AGENT}/health", timeout=10).json()
    print(f"health: {health}")
    assert health.get("nemotron_reachable"), "NIM not reachable — start it first"

    print("\n━━ 1. conversational — capabilities (no tools expected)")
    r = run_turn("What is this system and what can you do for me?")
    check("1 no errors", not r["errors"], str(r["errors"]))
    check("1 answers in prose", len(r["final"]) > 80, f"{r['secs']}s · {r['final'][:70]}…")
    check("1 fires no tools", r["tools"] == [], str(r["tools"]))
    hist = turn_pair("What is this system and what can you do for me?", r["final"])

    print("\n━━ 2. knowledge graph — nearest service to a landmark")
    r = run_turn("Where is the nearest fire station to the Shard?")
    check("2 no errors", not r["errors"], str(r["errors"]))
    check("2 used a locate tool", any(t in ("find_nearest", "locate_place", "nearby_places")
                                      for t in r["tools"]), str(r["tools"]))
    check("2 names a fire station", "fire station" in r["final"].lower(), r["final"][:90])
    check("2 drove the map", "markers" in r["ops"], str(r["ops"]))
    hist2 = turn_pair("Where is the nearest fire station to the Shard?", r["final"])

    print("\n━━ 3. follow-up with history — nearest hospital (context carry-over)")
    r = run_turn("And the nearest hospital?", history=hist2)
    check("3 no errors", not r["errors"], str(r["errors"]))
    check("3 used a locate tool", any(t in ("find_nearest", "nearby_places", "locate_place")
                                      for t in r["tools"]), str(r["tools"]))
    check("3 names a hospital", "hospital" in r["final"].lower(), r["final"][:90])

    print("\n━━ 4. gazetteer alias — fly to the Walkie-Talkie (new KG entry)")
    r = run_turn("Fly to the Walkie-Talkie")
    check("4 no errors", not r["errors"], str(r["errors"]))
    check("4 locate_place fired", "locate_place" in r["tools"], str(r["tools"]))
    check("4 resolved 20 Fenchurch", "fenchurch" in r["final"].lower()
          or "walkie" in r["final"].lower(), r["final"][:90])
    hist4 = turn_pair("Fly to the Walkie-Talkie", r["final"])

    print("\n━━ 5. follow-up — what's around it?")
    r = run_turn("What's around it?", history=hist4)
    check("5 no errors", not r["errors"], str(r["errors"]))
    check("5 nearby_places fired", "nearby_places" in r["tools"], str(r["tools"]))
    check("5 lists places", len(r["final"]) > 40, r["final"][:90])

    print("\n━━ 6. mast inventory — towers near Old Street")
    r = run_turn("How many masts are within a kilometre of Old Street?")
    check("6 no errors", not r["errors"], str(r["errors"]))
    check("6 find_masts fired", "find_masts" in r["tools"], str(r["tools"]))
    check("6 gives a count", any(ch.isdigit() for ch in r["final"]), r["final"][:90])

    print("\n━━ 7. network overview")
    r = run_turn("Give me a network overview — how big is it and what's the coverage?")
    check("7 no errors", not r["errors"], str(r["errors"]))
    check("7 describe_network fired", "describe_network" in r["tools"], str(r["tools"]))
    check("7 quotes real KPIs", "masts" in r["final"].lower() and "%" in r["final"],
          r["final"][:90])

    print("\n━━ 8. starlink — live pass right now")
    r = run_turn("Which Starlink satellite would a COW at London Bridge backhaul through "
                 "right now?")
    check("8 no errors", not r["errors"], str(r["errors"]))
    check("8 check_starlink fired", "check_starlink" in r["tools"], str(r["tools"]))
    check("8 names a satellite", "starlink" in r["final"].lower(), r["final"][:90])

    print("\n━━ 9. outage — real Sionna RT re-sim of two named masts (takes a while)")
    p9 = f"Simulate masts {MASTS[0]} and {MASTS[1]} going offline"
    r = run_turn(p9, selected=MASTS)
    check("9 no errors", not r["errors"], str(r["errors"]))
    check("9 simulate_outage fired", "simulate_outage" in r["tools"], str(r["tools"]))
    sim_result = r["results"].get("simulate_outage", "")
    check("9 twin re-simulated", "Sionna" in sim_result or "dead zone" in sim_result,
          f"{r['secs']}s · {sim_result[:80]}")
    check("9 painted zones", "zones" in r["ops"] or "markers" in r["ops"], str(r["ops"]))
    check("9 substantive final", len(r["final"]) > 60, r["final"][:90])
    hist9 = turn_pair(p9, r["final"])

    print("\n━━ 10. follow-up — choose the COW restoration path")
    r = run_turn("Deploy the cell-on-wheels option please", history=hist9, selected=MASTS)
    check("10 no errors", not r["errors"], str(r["errors"]))
    check("10 deploy_cow fired", "deploy_cow" in r["tools"], str(r["tools"]))
    check("10 starlink follows", "check_starlink" in r["tools"], str(r["tools"]))
    check("10 names the depot", "fire station" in r["final"].lower(), r["final"][:110])
    check("10 cow on the map", "cow" in r["ops"], str(r["ops"]))

    print("\n━━ 11. optimise — cuOpt plan + EA-LiDAR validation")
    r = run_turn("Optimise new permanent mast placement to fix the remaining coverage holes")
    check("11 no errors", not r["errors"], str(r["errors"]))
    check("11 cuopt fired", "run_cuopt" in r["tools"], str(r["tools"]))
    cu = r["results"].get("run_cuopt", "")
    check("11 real proposals", "propose" in cu.lower() or "mast" in cu.lower(), cu[:80])
    check("11 substantive final", len(r["final"]) > 60, f"{r['secs']}s · {r['final'][:90]}")

    print("\n━━ 12. relocate a mast — real twin re-sim")
    r = run_turn(f"Move mast {MASTS[0]} to 51.515, -0.075")
    check("12 no errors", not r["errors"], str(r["errors"]))
    check("12 move_mast fired", "move_mast" in r["tools"], str(r["tools"]))
    mv = r["results"].get("move_mast", "")
    check("12 twin re-simulated", "Sionna" in mv, mv[:80])

    print("\n━━ 13. graceful miss — unknown place")
    r = run_turn("Fly to Hogwarts School of Witchcraft please")
    check("13 no errors", not r["errors"], str(r["errors"]))
    check("13 honest miss", len(r["final"]) > 20, r["final"][:90])

    print(f"\n━━ RESULT: {len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILED:", FAIL)
    # Leave the twin on its baseline for the operator.
    try:
        states = httpx.get(f"{TWIN}/api/history", timeout=10).json()["states"]
        httpx.post(f"{TWIN}/api/restore", json={"id": states[0]["id"]}, timeout=60)
        print("(twin restored to baseline)")
    except Exception as e:  # noqa: BLE001
        print("(could not restore baseline:", e, ")")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

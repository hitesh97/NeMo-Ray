"""Smoke test for the agent's spatial knowledge graph (places.py) and the three
knowledge-graph tools (locate_place / nearby_places / describe_network).

Exercises name resolution, the gazetteer↔dashboard sync invariant, neighbourhood queries,
and that each tool emits a camera `focus` directive — all offline (no GPU/twin/NIM), against
the bundled gazetteer + emergency CSVs.

Run from the repo root with the AGENT venv (it needs httpx/pyproj, not Sionna):
    PYTHONPATH=agent agent/.venv/bin/python -m tests.knowledge_graph_smoke

Named like the other agent-venv scripts (not `test_*`) so pytest — which runs under the
twin `.venv` — does not try to collect it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from nemoray_modelling import places as P
from nemoray_modelling.tools import ToolRegistry

_REPO = Path(__file__).resolve().parents[1]
_GAZETTEER = _REPO / "nemoray" / "public" / "geo" / "landmarks.json"


def _focus(res) -> dict | None:
    for a in res.ui_actions:
        if a.get("focus"):
            return a["focus"]
    return None


def test_gazetteer_is_the_single_source() -> None:
    """The canonical gazetteer exists where BOTH the HUD (fetch /geo/landmarks.json) and the
    agent (places.load_landmarks) read it, and every map-labelled entry is in-bbox."""
    assert _GAZETTEER.is_file(), f"missing canonical gazetteer at {_GAZETTEER}"
    raw = json.loads(_GAZETTEER.read_text())["places"]
    labelled = [p for p in raw if p.get("label")]
    assert labelled, "no label:true entries — the dashboard map would lose all labels"
    b = P.LONDON_BBOX
    for p in raw:
        assert b["lat_min"] <= p["lat"] <= b["lat_max"], (p["id"], "lat out of bbox")
        assert b["lng_min"] <= p["lng"] <= b["lng_max"], (p["id"], "lng out of bbox")
    print(f"  gazetteer: {len(raw)} places, {len(labelled)} map-labelled, all in-bbox")


def test_graph_unions_gazetteer_and_emergency() -> None:
    nodes = P.load_places()
    cats = {c: 0 for c in P.PLACE_CATEGORIES + P.EMERGENCY_CATEGORIES}
    for n in nodes:
        cats[n["category"]] = cats.get(n["category"], 0) + 1
    assert len(P.load_landmarks()) >= 50, "gazetteer too small"
    for k in P.EMERGENCY_CATEGORIES:
        assert cats[k] > 0, f"no {k} buildings merged into the graph (CSV sync broken?)"
    print(f"  graph: {len(nodes)} nodes by category {cats}")


def test_resolution() -> None:
    """Landmarks, areas, named emergency buildings, fuzzy/typo, and aliases all resolve."""
    cases = {
        "tower bridge": "Tower Bridge",
        "the shard": "The Shard",
        "canary wharf": "Canary Wharf",
        "gherkin": "The Gherkin",          # alias → 30 St Mary Axe
        "the o2": "The O2 Arena",
        "wemberly stadium": "Wembley Stadium",   # typo
        "kings cross": "King's Cross St Pancras",
        "guys hospital": "Guy's Hospital",       # named emergency building
        "royal london": "Royal London Hospital",
    }
    for q, expected in cases.items():
        r = P.resolve_place(q)
        assert r is not None, f"{q!r} did not resolve"
        assert r["name"] == expected, f"{q!r} → {r['name']!r}, expected {expected!r}"
    # Category narrowing + a genuine miss returning suggestions, not a wrong hit.
    assert P.resolve_place("st thomas", categories=("hospital",))["category"] == "hospital"
    assert P.resolve_place("absolute gibberish zzqx") is None
    assert P.suggest_places("absolute gibberish zzqx"), "expected fallback suggestions"
    print(f"  resolution: {len(cases)} names + alias/typo/category/miss all correct")


def test_every_label_resolves() -> None:
    """Every place the operator can see labelled on the map is resolvable by the agent."""
    raw = json.loads(_GAZETTEER.read_text())["places"]
    for p in (x for x in raw if x.get("label")):
        r = P.resolve_place(p["name"])
        assert r is not None and r["id"] == p["id"], f"label {p['name']!r} not self-resolving"
    print("  every map label resolves back to its own node")


def test_nearby_sorted_and_filtered() -> None:
    near = P.nearby_places(51.5045, -0.0865, 1.0)   # around the Shard
    assert near and near[0]["distance_km"] <= near[-1]["distance_km"], "not nearest-first"
    hosp = P.nearby_places(51.5045, -0.0865, 3.0, categories=("hospital",))
    assert hosp and all(h["category"] == "hospital" for h in hosp), "category filter leaked"
    print(f"  nearby: {len(near)} within 1km of the Shard, hospital filter clean")


def test_tools_emit_camera_focus() -> None:
    r = ToolRegistry()
    names = {s.name for s in r.specs()}
    assert {"locate_place", "nearby_places", "describe_network"} <= names

    loc = r.run("locate_place", {"query": "tower bridge"})
    f = _focus(loc)
    assert f and f["center"] == [-0.0754, 51.5055], f"locate_place focus wrong: {f}"
    assert loc.observation["source"] == "knowledge-graph"

    miss = r.run("locate_place", {"query": "zzzz not a place"})
    assert miss.observation.get("error") == "unresolved" and not miss.ui_actions

    nb = r.run("nearby_places", {"query": "the shard", "radius_km": 0.6})
    assert _focus(nb) and "bbox" in _focus(nb), "nearby_places should fit a bbox"
    assert nb.observation["results"], "nearby_places returned nothing around the Shard"

    net = r.run("describe_network", {})
    # describe_network frames the simulated area when summary.json is present.
    assert net.observation["source"] in ("pipeline summary.json", "none")

    masts = r.run("find_masts", {"query": "the shard", "radius_km": 0.5})
    # masts.geojson is a gitignored pipeline output — present in dev, absent on a fresh clone.
    if masts.observation["source"] == "masts.geojson":
        assert masts.observation["count"] >= 1, "no masts found around the Shard"
        assert _focus(masts), "find_masts should drive the camera"
    print("  tools: locate_place / nearby_places / describe_network / find_masts drive the camera")


def test_cuopt_and_coverage_show_all_not_one() -> None:
    """Regression for the 'cuOpt/dead-zones point to a single Westminster spot' bug: offline,
    run_cuopt must emit a marker per proposed mast (the whole plan) and run_sionna_coverage must
    paint every real hole — when the pipeline artifacts are present."""
    import os as _os

    from nemoray_modelling import places as _P

    r = ToolRegistry()
    _os.environ.pop("TWIN_URL", None)

    have_masts = bool(_P.load_proposed_masts())
    have_holes = bool(_P.load_hotspots())

    cu = r.run("run_cuopt", {})
    markers = next((a["markers"] for a in cu.ui_actions if a.get("op") == "markers"), [])
    cands = cu.observation.get("candidates", [])
    if have_masts:
        assert len(markers) > 1, f"run_cuopt emitted {len(markers)} marker(s) — expected the full plan"
        assert len(cands) == len(markers), "observation candidates must match emitted markers"
        assert cu.observation["source"].startswith("cuOpt output artifact")
        # Exactly one marker is labelled — the recommended (highest-impact) pick.
        assert sum(1 for m in markers if m.get("label")) == 1
        # reject→retry recommends a DIFFERENT mast.
        pick1 = cu.observation["candidate"]["candidate_id"]
        cu2 = r.run("run_cuopt", {"exclude": [pick1]})
        assert cu2.observation["candidate"]["candidate_id"] != pick1, "exclude didn't change the pick"
        print(f"  run_cuopt: {len(markers)} candidate markers, 1 recommended, exclude reselects")
    else:
        print("  run_cuopt: no new_masts.geojson artifact — skipped (fresh clone)")

    cov = r.run("run_sionna_coverage", {"disabled_cells": []})
    zones = next((a["zones"] for a in cov.ui_actions if a.get("op") == "zones"), [])
    if have_holes:
        assert len(zones) > 1, f"run_sionna_coverage painted {len(zones)} zone(s) — expected all holes"
        assert cov.observation["source"].startswith("coverage artifact")
        print(f"  run_sionna_coverage: {len(zones)} real dead zones painted")
    else:
        print("  run_sionna_coverage: no hotspots.geojson artifact — skipped (fresh clone)")


def main() -> int:
    tests = [
        test_gazetteer_is_the_single_source,
        test_graph_unions_gazetteer_and_emergency,
        test_resolution,
        test_every_label_resolves,
        test_nearby_sorted_and_filtered,
        test_tools_emit_camera_focus,
        test_cuopt_and_coverage_show_all_not_one,
    ]
    failed = 0
    for t in tests:
        try:
            print(f"• {t.__name__}")
            t()
        except AssertionError as exc:
            failed += 1
            print(f"  FAILED: {exc}")
    print()
    if failed:
        print(f"✗ {failed}/{len(tests)} knowledge-graph checks failed")
        return 1
    print(f"✓ all {len(tests)} knowledge-graph checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

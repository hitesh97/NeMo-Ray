"""Phase 2 — optimise where to add new masts to fix coverage holes, using cuOpt.

Frames it as a Maximal-Coverage / set-cover MILP:

    decision:   y_j ∈ {0,1}  build a new mast at candidate site j
    minimise:   Σ y_j                                  (fewest new masts)
    subject to: Σ_{j covers i} y_j ≥ 1  for every weak spot i   (cover every hole)

A candidate site "covers" a weak spot if it lies within `coverage_radius_m`. Demand
points are the low-coverage hotspot centroids from the Sionna RT pass; candidate sites are
a grid over the weak areas. The MILP is solved on NVIDIA's hosted cuOpt service.
"""
from __future__ import annotations

import json
import os

import numpy as np

from . import cuopt
from .config import load_config
from .geo import en_to_lnglat, lnglat_to_en
from .masts import load_sites
from .osm import load_buildings


def _load_demands(cfg) -> tuple[np.ndarray, list[float]]:
    """Weak-spot demand points (EPSG:27700) and their areas, from hotspots.geojson."""
    path = os.path.join(cfg["paths"]["out_dir"], "hotspots.geojson")
    with open(path) as f:
        fc = json.load(f)
    pts, areas = [], []
    for feat in fc["features"]:
        g = feat["geometry"]
        ring = g["coordinates"][0][0] if g["type"] == "MultiPolygon" else g["coordinates"][0]
        xs = [c[0] for c in ring]
        ys = [c[1] for c in ring]
        clng, clat = sum(xs) / len(xs), sum(ys) / len(ys)
        e, n = lnglat_to_en(clng, clat)
        pts.append([e, n])
        # crude area weight via lat/lng extent (only used for reporting)
        areas.append((max(xs) - min(xs)) * (max(ys) - min(ys)))
    return np.array(pts, dtype=float).reshape(-1, 2), areas


def _candidate_grid(dem: np.ndarray, spacing: float, radius: float, tree, geoms) -> np.ndarray:
    """Grid of candidate sites (EPSG:27700) within `radius` of a demand and NOT sitting
    inside a building footprint."""
    e_min, n_min = dem.min(axis=0) - radius
    e_max, n_max = dem.max(axis=0) + radius
    es = np.arange(e_min, e_max + spacing, spacing)
    ns = np.arange(n_min, n_max + spacing, spacing)
    grid = np.array([[e, n] for n in ns for e in es], dtype=float)
    d2 = ((grid[:, None, :] - dem[None, :, :]) ** 2).sum(-1)
    near = d2.min(axis=1) <= radius * radius
    grid = grid[near]
    # Drop candidates that fall inside a building.
    from shapely.geometry import Point
    keep = []
    for e, n in grid:
        hit = tree.query(Point(e, n), predicate="intersects")
        keep.append(len(hit) == 0)
    return grid[np.array(keep, dtype=bool)] if len(grid) else grid


def _los_coverage(cand: np.ndarray, dem: np.ndarray, near: float, far: float,
                  tree) -> np.ndarray:
    """covers[j, i] = candidate j serves demand i. A mast covers a weak spot if it is
    very close (within `near` — short-range multipath fills the shadow) OR within `far`
    with a clear line of sight (no building footprint between them)."""
    from shapely.geometry import LineString
    near2, far2 = near * near, far * far
    covers = np.zeros((len(cand), len(dem)), dtype=bool)
    for j, (ce, cn) in enumerate(cand):
        d2 = ((dem - [ce, cn]) ** 2).sum(axis=1)
        covers[j, d2 <= near2] = True
        for i in np.nonzero((d2 > near2) & (d2 <= far2))[0]:
            seg = LineString([(ce, cn), (dem[i, 0], dem[i, 1])])
            if len(tree.query(seg, predicate="intersects")) == 0:
                covers[j, i] = True
    return covers


def optimize(cfg) -> dict:
    radius = float(cfg["cuopt"]["coverage_radius_m"])
    spacing = float(cfg["cuopt"]["candidate_spacing_m"])
    height = float(cfg["cuopt"]["new_mast_height_m"])

    dem, areas = _load_demands(cfg)
    if len(dem) == 0:
        print("No coverage holes to optimise — nothing to do.")
        _write_empty(cfg)
        return {"selected": 0, "demands": 0}

    # Building footprints near the weak areas, for line-of-sight tests.
    from shapely.strtree import STRtree
    buildings = load_buildings(cfg)
    pad = radius + 50.0
    e0, n0 = dem.min(axis=0) - pad
    e1, n1 = dem.max(axis=0) + pad
    bsub = buildings.cx[e0:e1, n0:n1]
    geoms = list(bsub.geometry.values)
    tree = STRtree(geoms)

    # Keep only OUTDOOR holes — a low-coverage cell whose centroid sits inside a building
    # footprint is a radio-map artifact (no one needs outdoor service inside a building).
    from shapely.geometry import Point
    outdoor = np.array([len(tree.query(Point(e, n), predicate="intersects")) == 0
                        for (e, n) in dem])
    n_indoor = int((~outdoor).sum())
    dem = dem[outdoor]
    print(f"  {len(dem)} outdoor weak spots ({n_indoor} indoor artifacts dropped), "
          f"{len(geoms)} buildings in play")
    if len(dem) == 0:
        print("No outdoor coverage holes — nothing to optimise.")
        _write_empty(cfg)
        return {"new_masts": 0, "coverage_holes": 0}

    near = float(cfg["cuopt"]["near_radius_m"])
    cand = _candidate_grid(dem, spacing, radius, tree, geoms)
    # Also allow a mast right at each weak spot (if that point isn't inside a building),
    # so even deep, enclosed holes are coverable by a co-located mast.
    from shapely.geometry import Point
    at_hole = np.array([[e, n] for (e, n) in dem
                        if len(tree.query(Point(e, n), predicate="intersects")) == 0])
    if len(at_hole):
        cand = np.vstack([cand, at_hole]) if len(cand) else at_hole
    # Coverage = close-range (multipath) OR line-of-sight at medium range.
    covers = _los_coverage(cand, dem, near, radius, tree)
    coverable = covers.any(axis=0)
    n_uncoverable = int((~coverable).sum())
    print(f"  {len(cand)} candidate sites, "
          f"{int(coverable.sum())}/{len(dem)} holes are coverable")

    # Build the set-cover MILP in cuOpt's CSR format. One constraint per coverable demand:
    #   Σ_{j covers i} y_j >= 1
    n_cand = len(cand)
    offsets, indices, values = [0], [], []
    for i in range(len(dem)):
        if not coverable[i]:
            continue
        js = np.nonzero(covers[:, i])[0]
        indices.extend(int(j) for j in js)
        values.extend(1.0 for _ in js)
        offsets.append(len(indices))
    n_constraints = len(offsets) - 1

    data = {
        "csr_constraint_matrix": {"offsets": offsets, "indices": indices, "values": values},
        "constraint_bounds": {
            "lower_bounds": [1.0] * n_constraints,
            "upper_bounds": [float(n_cand)] * n_constraints,
        },
        "objective_data": {
            "coefficients": [1.0] * n_cand, "scalability_factor": 1.0, "offset": 0.0,
        },
        "variable_bounds": {"lower_bounds": [0.0] * n_cand, "upper_bounds": [1.0] * n_cand},
        "maximize": False,
        "variable_names": [f"y{j}" for j in range(n_cand)],
        "variable_types": ["I"] * n_cand,
        "solver_config": {"time_limit": int(cfg["cuopt"]["time_limit_s"])},
    }

    print("  solving MILP on NVIDIA cuOpt (hosted)...")
    resp = cuopt.solve_milp(data, cfg["cuopt"]["api_key"], cfg["cuopt"]["url"])
    sol = cuopt.read_solution(resp)
    chosen = [j for j in range(n_cand)
              if sol["vars"].get(f"y{j}", 0.0) > 0.5]
    print(f"  cuOpt: {sol['status']}, {len(chosen)} new masts "
          f"(solve {sol['solve_time']:.2f}s)")

    # Assemble the proposed new masts + coverage stats.
    feats = []
    covered_demands = set()
    for j in chosen:
        served = np.nonzero(covers[j] & coverable)[0]
        covered_demands.update(int(i) for i in served)
        lng, lat = en_to_lnglat(cand[j, 0], cand[j, 1])
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(lng), float(lat)]},
            "properties": {"id": f"new-{j}", "height_m": height,
                           "covers_holes": int(served.size),
                           "radius_m": radius},
        })
    out = cfg["paths"]["out_dir"]
    with open(os.path.join(out, "new_masts.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)

    summary = {
        "existing_masts": len(load_sites(cfg)),
        "coverage_holes": int(len(dem)),
        "holes_coverable": int(coverable.sum()),
        "holes_uncoverable": n_uncoverable,
        "candidate_sites": n_cand,
        "new_masts": len(chosen),
        "holes_now_covered": len(covered_demands),
        "coverage_radius_m": radius,
        "solver": "NVIDIA cuOpt (hosted MILP)",
        "status": sol["status"],
        "objective": sol["objective"],
        "solve_time_s": round(sol["solve_time"], 3) if sol["solve_time"] else None,
    }
    with open(os.path.join(out, "optimization.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("\n=== Optimisation summary ===")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    return summary


def _write_empty(cfg):
    out = cfg["paths"]["out_dir"]
    with open(os.path.join(out, "new_masts.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": []}, f)
    with open(os.path.join(out, "optimization.json"), "w") as f:
        json.dump({"new_masts": 0, "coverage_holes": 0,
                   "solver": "NVIDIA cuOpt (hosted MILP)"}, f, indent=2)


def main():
    cfg = load_config()
    optimize(cfg)


if __name__ == "__main__":
    main()

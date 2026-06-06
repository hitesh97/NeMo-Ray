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


def _inside_building(pts: np.ndarray, btree) -> np.ndarray:
    """Boolean mask: which points (EPSG:27700) fall inside a building footprint.
    Vectorised STRtree query — scales to tens of thousands of points."""
    import shapely
    if len(pts) == 0:
        return np.zeros(0, dtype=bool)
    geoms = shapely.points(pts[:, 0], pts[:, 1])
    hit = btree.query(geoms, predicate="intersects")  # (2, K): [point_idx, tree_idx]
    mask = np.zeros(len(pts), dtype=bool)
    if hit.size:
        mask[np.unique(hit[0])] = True
    return mask


def _candidates_near(dem: np.ndarray, spacing: float, radius: float, btree) -> np.ndarray:
    """Candidate sites on a global lattice, generated LOCALLY around each demand (so the
    count scales with the number of holes, not the bounding-box area), deduplicated, and
    with in-building points removed. Includes each hole's own cell (a co-located mast)."""
    rc = int(round(radius / spacing))
    cells = set()
    for e, n in dem:
        ci, cj = round(e / spacing), round(n / spacing)
        for di in range(-rc, rc + 1):
            for dj in range(-rc, rc + 1):
                if di * di + dj * dj <= rc * rc:
                    cells.add((ci + di, cj + dj))
    cand = np.array([[i * spacing, j * spacing] for i, j in cells], dtype=float)
    return cand[~_inside_building(cand, btree)] if len(cand) else cand


def _coverage_rows(cand: np.ndarray, dem: np.ndarray, near: float, far: float, btree):
    """Sparse coverage: for each demand, the list of candidate indices that serve it.
    Served = within `near` (short-range multipath) OR within `far` with clear line of
    sight. Uses a KD-tree so it scales to large problems."""
    from scipy.spatial import cKDTree
    from shapely.geometry import LineString
    near2 = near * near
    ctree = cKDTree(cand)
    rows = [[] for _ in range(len(dem))]
    for i, (de, dn) in enumerate(dem):
        for j in ctree.query_ball_point((de, dn), far):
            d2 = (cand[j, 0] - de) ** 2 + (cand[j, 1] - dn) ** 2
            if d2 <= near2:
                rows[i].append(j)
            else:
                seg = LineString([(cand[j, 0], cand[j, 1]), (de, dn)])
                if len(btree.query(seg, predicate="intersects")) == 0:
                    rows[i].append(j)
    return rows


def optimize(cfg) -> dict:
    radius = float(cfg["cuopt"]["coverage_radius_m"])
    spacing = float(cfg["cuopt"]["candidate_spacing_m"])
    height = float(cfg["cuopt"]["new_mast_height_m"])

    near = float(cfg["cuopt"]["near_radius_m"])
    max_holes = int(cfg["cuopt"].get("max_holes", 1200))

    dem, areas = _load_demands(cfg)
    if len(dem) == 0:
        print("No coverage holes to optimise — nothing to do.")
        _write_empty(cfg)
        return {"new_masts": 0, "coverage_holes": 0}

    # Building footprints for line-of-sight + outdoor tests.
    from shapely.strtree import STRtree
    buildings = load_buildings(cfg)
    pad = radius + 50.0
    e0, n0 = dem.min(axis=0) - pad
    e1, n1 = dem.max(axis=0) + pad
    tree = STRtree(list(buildings.cx[e0:e1, n0:n1].geometry.values))

    # Keep only OUTDOOR holes (centroid not inside a building); indoor cells are artifacts.
    areas = np.asarray(areas, dtype=float)
    outdoor = ~_inside_building(dem, tree)
    dem, areas = dem[outdoor], areas[outdoor]
    n_total_outdoor = len(dem)
    if n_total_outdoor == 0:
        print("No outdoor coverage holes — nothing to optimise.")
        _write_empty(cfg)
        return {"new_masts": 0, "coverage_holes": 0}

    # Optimisation is a regional tool — cap to the largest gaps so the MILP (and the RT
    # verification that follows) stays tractable on a Greater-London-wide run.
    capped = False
    if n_total_outdoor > max_holes:
        keep = np.argsort(areas)[::-1][:max_holes]
        dem, areas = dem[keep], areas[keep]
        capped = True
    print(f"  {len(dem)} outdoor weak spots optimised"
          + (f" (largest of {n_total_outdoor}; cap {max_holes})" if capped else ""))

    # Candidate sites = the weak-spot locations themselves: placing a mast at one hole
    # covers it and its near/LOS neighbours. This dominating-set formulation keeps the
    # MILP at <= max_holes binary variables, small enough for the hosted cuOpt solver.
    cand = dem.copy()
    rows = _coverage_rows(cand, dem, near, radius, tree)
    coverable = np.array([len(r) > 0 for r in rows])
    n_uncoverable = int((~coverable).sum())
    print(f"  {len(cand)} candidate sites, "
          f"{int(coverable.sum())}/{len(dem)} holes are coverable")

    # Build the set-cover MILP in cuOpt's CSR format. One constraint per coverable demand:
    #   Σ_{j covers i} y_j >= 1
    n_cand = len(cand)
    offsets, indices, values = [0], [], []
    for i, r in enumerate(rows):
        if not r:
            continue
        indices.extend(int(j) for j in r)
        values.extend(1.0 for _ in r)
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

    # Invert the sparse coverage to count what each chosen mast serves.
    chosen_set = set(chosen)
    serves = {j: [] for j in chosen}
    for i, r in enumerate(rows):
        for j in r:
            if j in chosen_set:
                serves[j].append(i)

    feats = []
    covered_demands = set()
    for j in chosen:
        covered_demands.update(serves[j])
        lng, lat = en_to_lnglat(cand[j, 0], cand[j, 1])
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(lng), float(lat)]},
            "properties": {"id": f"new-{j}", "height_m": height,
                           "covers_holes": len(serves[j]),
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

"""Re-simulate the coverage twin after a change — the engine behind the agent.

`resimulate()` takes a set of existing masts to DISABLE and a set of new masts to ADD
(e.g. a relocated mast, or a Cell-on-Wheels), re-runs Sionna RT for only the affected
tiles, re-mosaics, re-exports the coverage heatmap + holes, and re-traces the rays for
those tiles. It is the shared backend for the agent tools `simulate_outage`, `move_mast`
and `deploy_cow` (all of which POST to the twin's `/api/coverage`).

This generalises `src/verify.py` (which only ever *added* cuOpt masts): same tile cache,
same re-mosaic/re-export, but parameterised on (disabled, added).
"""
from __future__ import annotations

import json
import os
import time

from . import export, rt as RT
from .geo import lnglat_to_en
from .gpu import GpuMonitor, perf_summary
from .masts import Site, load_sites
from .mosaic import Mosaic
from .osm import load_buildings
from .scene_builder import build_tile_scene
from .verify import _load_cached, _reconstruct_tiles


def _write_perf(cfg, perf) -> None:
    """Persist in-session GPU telemetry for the viewer's Compute panel."""
    with open(os.path.join(cfg["paths"]["out_dir"], "perf.json"), "w") as f:
        json.dump(perf, f)


def _build_added_sites(cfg, added) -> list[Site]:
    """Turn [{id,lat,lng,height_m?}] into Site transmitters (proposed masts / COWs)."""
    power = float(cfg["cuopt"]["new_mast_power_dbm"])
    default_h = float(cfg["cuopt"]["new_mast_height_m"])
    out: list[Site] = []
    for a in added or []:
        lat, lng = a.get("lat"), a.get("lng")
        if lat is None or lng is None:
            continue
        lat, lng = float(lat), float(lng)
        e, n = lnglat_to_en(lng, lat)
        out.append(Site(id=str(a.get("id", "added")), operator="EE-new", lat=lat, lng=lng,
                        e=e, n=n, height_m=float(a.get("height_m", default_h)),
                        power_dbm=power))
    return out


def _rays_fc(ray_dicts) -> dict:
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature",
         "geometry": {"type": "LineString", "coordinates": r["coords"]},
         "properties": {"operator": r["operator"], "bounces": r["bounces"]}}
        for r in ray_dicts]}


def _write_rays(cfg, ray_dicts, name: str) -> None:
    with open(os.path.join(cfg["paths"]["out_dir"], name), "w") as f:
        json.dump(_rays_fc(ray_dicts), f)


def _affected(cfg, disabled_ids, added):
    """Resolve (sites_now, buildings, tiles, affected_keys, matched, unknown) for a change.

    A tile's coverage/rays depend on every mast within tx_radius of its centre, so any tile
    within tx_radius of a changed (disabled or added) mast is 'affected'."""
    half = cfg["tiling"]["tile_size_m"] / 2
    tx_radius = half + cfg["tiling"].get("tx_radius_m", 1500.0)
    max_tiles = int(cfg["cuopt"].get("max_verify_tiles", 60))

    disabled_set = {str(x) for x in (disabled_ids or [])}
    all_sites = load_sites(cfg)
    by_id = {s.id: s for s in all_sites}
    matched = sorted(disabled_set & by_id.keys())
    unknown = sorted(disabled_set - by_id.keys())
    added_sites = _build_added_sites(cfg, added)
    sites_now = [s for s in all_sites if s.id not in disabled_set] + added_sites

    tiles = _reconstruct_tiles(cfg)
    changed = [by_id[i] for i in matched] + added_sites
    affected = [t for t, _ in tiles
                if any(abs(c.e - t.e0) <= tx_radius and abs(c.n - t.n0) <= tx_radius
                       for c in changed)]
    affected_keys = {t.key for t in affected[:max_tiles]}
    buildings = load_buildings(cfg)
    return sites_now, buildings, tiles, affected_keys, matched, unknown, added_sites


def resimulate(cfg, disabled_ids=None, added=None, trace_rays=False) -> dict:
    """Re-solve the affected tiles with `disabled_ids` removed and `added` masts added.

    Coverage-only by default (fast — the agent calls this several times per turn). Pass
    trace_rays=True to also re-trace the affected-tile rays in the same pass; otherwise the
    viewer fires `trace_affected_rays` (POST /api/rays) after the change. Re-writes
    out/coverage.png + out/hotspots.geojson. Returns the summary the agent consumes.
    """
    half = cfg["tiling"]["tile_size_m"] / 2
    thr = cfg["coverage"]["served_threshold_dbm"]
    (sites_now, buildings, tiles, affected_keys,
     matched, unknown, added_sites) = _affected(cfg, disabled_ids, added)

    ring = int(cfg["radio"].get("resim_ray_ring", 4))
    ray_cap = int(cfg["radio"].get("resim_ray_cap", 20000))

    monitor = GpuMonitor().start()             # capture this run's GPU telemetry
    t0 = time.time()
    latencies, results, ray_dicts = [], [], []
    for tile, cache in tiles:
        if tile.key not in affected_keys:
            results.append(_load_cached(cache, tile.key))
            continue
        xml, _ = build_tile_scene(cfg, tile, buildings)
        ts = time.time()
        res = RT.solve_tile(cfg, tile, xml, sites_now)
        if res is None:                            # no transmitter left illuminating it
            results.append(_load_cached(cache, tile.key))
            continue
        latencies.append((time.time() - ts) * 1000.0)
        results.append(res)
        if trace_rays and len(ray_dicts) < ray_cap:
            core = [s for s in sites_now
                    if abs(s.e - tile.e0) <= half and abs(s.n - tile.n0) <= half]
            if core:
                ray_dicts.extend(RT.trace_mast_rays(cfg, tile, xml, core, ring=ring))
    monitor.stop()

    mosaic = Mosaic(cfg["radio"]["cell_size_m"])
    for r in results:
        mosaic.add(r)
    mosaic.assemble()
    export.export_coverage(cfg, mosaic)
    hotspots = export.export_hotspots(cfg, mosaic, buildings)
    served = float((mosaic.dbm[mosaic.mask] >= thr).mean() * 100.0)

    if trace_rays:
        _write_rays(cfg, ray_dicts, "new_rays.geojson")

    perf = perf_summary(monitor, latencies, time.time() - t0)
    _write_perf(cfg, perf)

    return {
        "disabled_matched": matched,
        "disabled_unknown": unknown,
        "added": [s.id for s in added_sites],
        "coverage_holes": len(hotspots),
        "served_pct": round(served, 2),
        "tiles_resimulated": len(affected_keys),
        "new_rays": len(ray_dicts) if trace_rays else None,
        "performance": perf,
    }


def trace_affected_rays(cfg, disabled_ids=None, added=None) -> dict:
    """Re-trace rays ONLY for the tiles affected by a change (no coverage solve) →
    out/new_rays.geojson. The viewer calls this after a change so the traces in the
    changed segment refresh, without paying the radio-map solve again."""
    half = cfg["tiling"]["tile_size_m"] / 2
    ring = int(cfg["radio"].get("resim_ray_ring", 4))
    ray_cap = int(cfg["radio"].get("resim_ray_cap", 20000))
    (sites_now, buildings, tiles, affected_keys,
     matched, unknown, _added) = _affected(cfg, disabled_ids, added)

    ray_dicts = []
    for tile, _cache in tiles:
        if tile.key not in affected_keys or len(ray_dicts) >= ray_cap:
            continue
        xml, _ = build_tile_scene(cfg, tile, buildings)
        core = [s for s in sites_now
                if abs(s.e - tile.e0) <= half and abs(s.n - tile.n0) <= half]
        if core:
            ray_dicts.extend(RT.trace_mast_rays(cfg, tile, xml, core, ring=ring))
    _write_rays(cfg, ray_dicts, "new_rays.geojson")
    return {"new_rays": len(ray_dicts), "tiles": len(affected_keys),
            "disabled_matched": matched, "disabled_unknown": unknown}


def trace_all_rays(cfg, disabled_ids=None, added=None) -> dict:
    """Trace rays for the CURRENT mast set across every simulated tile → out/paths.geojson.

    This backs the viewer's explicit "trace rays" action (rays are not precomputed at
    startup; the user asks for them). Capped by radio.ray_total_cap.
    """
    disabled_set = {str(x) for x in (disabled_ids or [])}
    half = cfg["tiling"]["tile_size_m"] / 2
    ray_cap = int(cfg["radio"].get("ray_total_cap", 500000))

    all_sites = load_sites(cfg)
    added_sites = _build_added_sites(cfg, added)
    sites_now = [s for s in all_sites if s.id not in disabled_set] + added_sites
    buildings = load_buildings(cfg)
    tiles = _reconstruct_tiles(cfg)

    seen, rays = set(), []
    for tile, _ in tiles:
        core = [s for s in sites_now
                if s.id not in seen and abs(s.e - tile.e0) <= half and abs(s.n - tile.n0) <= half]
        if not core:
            continue
        for s in core:
            seen.add(s.id)
        xml, _b = build_tile_scene(cfg, tile, buildings)
        rays.extend(RT.trace_mast_rays(cfg, tile, xml, core))
        if len(rays) >= ray_cap:
            break

    feats = [{"type": "Feature",
              "geometry": {"type": "LineString", "coordinates": r["coords"]},
              "properties": {"operator": r["operator"], "bounces": r["bounces"]}}
             for r in rays]
    with open(os.path.join(cfg["paths"]["out_dir"], "paths.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)
    return {"rays": len(rays), "masts": len(seen)}

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
import threading
import time

from . import export
from . import rt as RT
from .geo import lnglat_to_en
from .gpu import GpuMonitor, perf_summary
from .masts import Site, load_sites, sites_in_tiles
from .mosaic import Mosaic
from .osm import load_buildings
from .scene_builder import build_tile_scene
from .verify import _load_cached, _reconstruct_tiles

# Buildings between the service threshold (-110 dBm) and this are DEGRADED: technically
# served, but deep in the heatmap's red band — the agent reports them alongside outages.
DEGRADED_DBM = -100.0


def _sample_building_service(cfg, mosaic, thr) -> list[dict]:
    """Sample the post-change radio map at every emergency-service building and return the
    ones that are out of service (< thr) or degraded (thr..DEGRADED_DBM). Ground truth per
    building — point-in-hole-polygon tests under-count campuses sitting in visibly red
    areas whose 25 m cells hover just above the hole threshold."""
    from .emergency import load_emergency_features
    out: list[dict] = []
    for f in load_emergency_features(cfg):
        lng, lat = f["geometry"]["coordinates"]
        e, n = lnglat_to_en(lng, lat)
        col = int((e - mosaic.e_left) / mosaic.cell)
        row = int((n - mosaic.n_bottom) / mosaic.cell)
        if not (0 <= row < mosaic.rows and 0 <= col < mosaic.cols):
            continue                      # outside the simulated grid entirely
        if not bool(mosaic.mask[row, col]):
            continue                      # cell was never simulated — no claim either way
        dbm = float(mosaic.dbm[row, col]) # NODATA inside the mask = genuinely no signal
        if dbm < DEGRADED_DBM:
            p = f["properties"]
            out.append({"name": p["name"], "kind": p["kind"],
                        "lat": lat, "lng": lng,
                        "dbm": round(dbm, 1), "served": bool(dbm >= thr)})
    out.sort(key=lambda b: b["dbm"])
    return out[:60]


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
    tiles = _reconstruct_tiles(cfg)
    # The network is clipped to the simulated footprint (same rule as the pipeline).
    all_sites = sites_in_tiles(load_sites(cfg), [t for t, _ in tiles], half)
    by_id = {s.id: s for s in all_sites}
    matched = sorted(disabled_set & by_id.keys())
    unknown = sorted(disabled_set - by_id.keys())
    added_sites = _build_added_sites(cfg, added)
    sites_now = [s for s in all_sites if s.id not in disabled_set] + added_sites

    changed = [by_id[i] for i in matched] + added_sites
    affected = [t for t, _ in tiles
                if any(abs(c.e - t.e0) <= tx_radius and abs(c.n - t.n0) <= tx_radius
                       for c in changed)]
    affected_keys = {t.key for t in affected[:max_tiles]}
    buildings = load_buildings(cfg)
    return sites_now, buildings, tiles, affected_keys, matched, unknown, added_sites


# ── re-sim result cache ────────────────────────────────────────────────────────
# resimulate() is deterministic in (disabled_ids, added, trace_rays): the per-tile
# baseline RT solve is geometry-keyed (data/tiles/…), so only the mast set varies and
# the same change always yields the same coverage. The GPU re-solve of the affected
# tiles is the slow part (seconds × N tiles) — yet the agent re-issues identical
# changes constantly (re-running "simulate masts X offline", or the coverage step of an
# optimise flow it already ran). So memoise the whole result INCLUDING the output
# artifacts the HUD fetches; on a repeat, just rewrite those files and return the cached
# summary — no GPU. Process-lifetime, tiny LRU (the box is ephemeral). Disable with
# NEMORAY_RESIM_CACHE=0.
_RESIM_CACHE: dict[str, dict] = {}
_RESIM_CACHE_ORDER: list[str] = []
_RESIM_CACHE_MAX = 12
# A single lock serialises re-sims: they all clobber the same out/ artifacts, so running
# two at once corrupts them regardless of the cache — serialising is the correct fix.
_RESIM_LOCK = threading.Lock()
# Output files whose contents depend on the mast change (so must be restored on a hit).
# coverage_bounds.json is the tile extent — invariant across re-sims — so leave it alone.
_RESIM_ARTIFACTS = ("coverage.png", "hotspots.geojson", "perf.json")


def _resim_sig(disabled_ids, added, trace_rays) -> str:
    """Stable signature of a re-sim request — order-independent in disabled ids and added
    masts, rounded so float jitter doesn't defeat the cache."""
    d = sorted(str(x) for x in (disabled_ids or []))
    a = sorted(
        [str(x.get("id", "added")),
         round(float(x["lat"]), 6), round(float(x["lng"]), 6),
         (round(float(x["height_m"]), 2) if x.get("height_m") is not None else None)]
        for x in (added or []) if x.get("lat") is not None and x.get("lng") is not None
    )
    return json.dumps([d, a, bool(trace_rays)], sort_keys=True)


def _resim_artifact_names(trace_rays) -> tuple[str, ...]:
    return _RESIM_ARTIFACTS + (("new_rays.geojson",) if trace_rays else ())


def _capture_artifacts(cfg, trace_rays) -> dict[str, bytes]:
    out = cfg["paths"]["out_dir"]
    blobs: dict[str, bytes] = {}
    for name in _resim_artifact_names(trace_rays):
        try:
            with open(os.path.join(out, name), "rb") as f:
                blobs[name] = f.read()
        except OSError:
            pass
    return blobs


def _restore_artifacts(cfg, blobs: dict[str, bytes]) -> None:
    out = cfg["paths"]["out_dir"]
    for name, data in blobs.items():
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)


def _cache_store(sig, result, artifacts) -> None:
    _RESIM_CACHE[sig] = {"result": dict(result), "artifacts": artifacts}
    if sig in _RESIM_CACHE_ORDER:
        _RESIM_CACHE_ORDER.remove(sig)
    _RESIM_CACHE_ORDER.append(sig)
    while len(_RESIM_CACHE_ORDER) > _RESIM_CACHE_MAX:
        _RESIM_CACHE.pop(_RESIM_CACHE_ORDER.pop(0), None)


def resimulate(cfg, disabled_ids=None, added=None, trace_rays=False) -> dict:
    """Re-solve the affected tiles with `disabled_ids` removed and `added` masts added.

    Coverage-only by default (fast — the agent calls this several times per turn). Pass
    trace_rays=True to also re-trace the affected-tile rays in the same pass; otherwise the
    viewer fires `trace_affected_rays` (POST /api/rays) after the change. Re-writes
    out/coverage.png + out/hotspots.geojson. Returns the summary the agent consumes.

    Memoised on (disabled_ids, added, trace_rays) — a repeat of the same change restores the
    cached artifacts and skips the GPU re-solve (disable with NEMORAY_RESIM_CACHE=0).
    """
    use_cache = os.environ.get("NEMORAY_RESIM_CACHE", "1") != "0"
    sig = _resim_sig(disabled_ids, added, trace_rays)

    with _RESIM_LOCK:
        if use_cache and sig in _RESIM_CACHE:
            entry = _RESIM_CACHE[sig]
            _restore_artifacts(cfg, entry["artifacts"])
            _RESIM_CACHE_ORDER.remove(sig)
            _RESIM_CACHE_ORDER.append(sig)            # bump LRU recency
            out = dict(entry["result"])
            out["cached"] = True
            return out
        result = _resimulate_uncached(cfg, disabled_ids, added, trace_rays)
        result["cached"] = False
        if use_cache:
            _cache_store(sig, result, _capture_artifacts(cfg, trace_rays))
        return result


def _resimulate_uncached(cfg, disabled_ids=None, added=None, trace_rays=False) -> dict:
    """The actual GPU re-solve — see resimulate() for the memoised entry point."""
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
    building_service = _sample_building_service(cfg, mosaic, thr)

    if trace_rays:
        _write_rays(cfg, ray_dicts, "new_rays.geojson")
        # Deliberately do NOT touch the master paths.geojson here: it always carries the
        # dense baseline ray field (ring=9, uncapped) for every mast, and the HUD hides a
        # downed mast's rays client-side. Re-sim traces are sparser (ring=4, capped), so
        # splicing them in would visibly erode the ray field with every outage. Only
        # verify.py mutates the master file — it appends/replaces the PROPOSED masts'
        # full-density rays, and /api/clear_proposals strips them again.

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
        # Radio-map truth per emergency building: out of service (< served threshold) or
        # degraded (threshold..-100 dBm) — the agent reports these, not polygon guesses.
        "building_service": building_service,
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

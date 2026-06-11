"""Write web artifacts for the Cesium viewer: a draped coverage PNG (+bounds), and
GeoJSON for masts, low-coverage hotspots and sample ray paths. All in WGS84."""
from __future__ import annotations

import json
import os

import numpy as np

from .rt import NODATA


def _reproject_to_4326(arr, transform, nodata, resampling):
    """Reproject a 27700 north-up array to EPSG:4326. Returns (dst, bounds_lonlat)."""
    import rasterio.warp as warp
    from rasterio.crs import CRS
    from rasterio.transform import array_bounds

    h, w = arr.shape
    left, bottom, right, top = array_bounds(h, w, transform)
    src_crs = CRS.from_epsg(27700)
    dst_crs = CRS.from_epsg(4326)
    dst_transform, dw, dh = warp.calculate_default_transform(
        src_crs, dst_crs, w, h, left, bottom, right, top)
    dst = np.full((dh, dw), nodata, dtype=arr.dtype)
    warp.reproject(source=arr, destination=dst,
                   src_transform=transform, src_crs=src_crs,
                   dst_transform=dst_transform, dst_crs=dst_crs,
                   src_nodata=nodata, dst_nodata=nodata, resampling=resampling)
    west, north = dst_transform * (0, 0)
    east, south = dst_transform * (dw, dh)
    return dst, (west, south, east, north)


def _colorize(dbm, simulated, vmin, vmax):
    """dBm -> RGBA PNG. RdYlGn ramp (red = weak/hole, green = strong); transparent
    where unsimulated. Range is centred on the service threshold so coverage holes
    stand out against otherwise-green central London."""
    import matplotlib
    cmap = matplotlib.colormaps["RdYlGn"]
    norm = np.clip((dbm - vmin) / (vmax - vmin), 0.0, 1.0)
    rgba = (cmap(norm) * 255).astype(np.uint8)
    rgba[..., 3] = np.where(simulated, 190, 0).astype(np.uint8)
    return rgba


def export_all(cfg, mosaic, sites, rays, n_buildings=0, performance=None, buildings=None):
    out = cfg["paths"]["out_dir"]
    os.makedirs(out, exist_ok=True)
    cov = cfg["coverage"]

    # --- Coverage heatmap PNG + low-coverage hotspots ---
    west, south, east, north = export_coverage(cfg, mosaic)
    hfeats = export_hotspots(cfg, mosaic, buildings)

    # --- Masts GeoJSON ---
    feats = []
    for s in sites:
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [s.lng, s.lat]},
            "properties": {"id": s.id, "operator": s.operator,
                           "height_m": round(s.height_m, 1),
                           "power_dbm": round(s.power_dbm, 1),
                           "bands": sorted(s.bands)},
        })
    _write_fc(os.path.join(out, "masts.geojson"), feats)

    # --- Ray paths GeoJSON (rays out of every computed mast) ---
    pfeats = []
    for r in rays:
        pfeats.append({"type": "Feature",
                       "geometry": {"type": "LineString", "coordinates": r["coords"]},
                       "properties": {"operator": r["operator"], "bounces": r["bounces"]}})
    _write_fc(os.path.join(out, "paths.geojson"), pfeats)

    # --- Summary ---
    served = mosaic.dbm[mosaic.mask]
    summary = {
        "sites_total": len(sites),
        "buildings": int(n_buildings),
        "simulated_cells": int(mosaic.mask.sum()),
        "served_pct": float((served >= cov["served_threshold_dbm"]).mean() * 100.0),
        "low_coverage_polys": len(hfeats),
        "ray_paths": len(pfeats),
        "masts_emitting_rays": len({(round(r["coords"][0][0], 6),
                                     round(r["coords"][0][1], 6)) for r in rays}),
        "coverage_bounds": {"west": west, "south": south, "east": east, "north": north},
    }
    if performance:
        summary["performance"] = performance
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    return summary


def export_coverage(cfg, mosaic):
    """Write the coverage heatmap PNG (WGS84) + bounds. Returns (west, south, east, north)."""
    from PIL import Image
    from rasterio.enums import Resampling

    out = cfg["paths"]["out_dir"]
    os.makedirs(out, exist_ok=True)
    transform = mosaic.transform()
    dbm4326, bounds = _reproject_to_4326(mosaic.dbm_northup(), transform, NODATA,
                                         Resampling.bilinear)
    mask4326, _ = _reproject_to_4326(np.flipud(mosaic.mask).astype(np.float32), transform,
                                     0.0, Resampling.nearest)
    vmin, vmax = -110.0, -80.0
    rgba = _colorize(dbm4326, mask4326 > 0.5, vmin=vmin, vmax=vmax)
    Image.fromarray(rgba, "RGBA").save(os.path.join(out, "coverage.png"))
    west, south, east, north = bounds
    with open(os.path.join(out, "coverage_bounds.json"), "w") as f:
        json.dump({"west": west, "south": south, "east": east, "north": north,
                   "vmin": vmin, "vmax": vmax}, f)
    return bounds


def export_hotspots(cfg, mosaic, buildings=None):
    """Write low-coverage hotspot polygons (WGS84). When `buildings` is given, drop holes
    whose centroid sits inside a building footprint (indoor radio-map artifacts), keeping
    only genuine outdoor coverage gaps. Returns the feature list."""
    out = cfg["paths"]["out_dir"]
    thr = cfg["coverage"]["served_threshold_dbm"]
    polys = mosaic.hotspots(thr)
    if buildings is not None and polys:
        from shapely.strtree import STRtree
        xs = [p.centroid.x for p in polys]
        ys = [p.centroid.y for p in polys]
        pad = 30.0
        bsub = buildings.cx[min(xs) - pad:max(xs) + pad, min(ys) - pad:max(ys) + pad]
        tree = STRtree(list(bsub.geometry.values))
        polys = [p for p in polys
                 if len(tree.query(p.centroid, predicate="intersects")) == 0]
    hfeats = []
    if polys:
        import geopandas as gpd
        gdf = gpd.GeoDataFrame(geometry=polys, crs="EPSG:27700").to_crs("EPSG:4326")
        for geom in gdf.geometry:
            hfeats.append({"type": "Feature", "geometry": geom.__geo_interface__,
                           "properties": {"kind": "low_coverage", "threshold_dbm": thr}})
    _write_fc(os.path.join(out, "hotspots.geojson"), hfeats)
    return hfeats


def export_buildings(cfg, buildings, mosaic):
    """Write the OSM building footprints within the simulated area to GeoJSON (WGS84)
    with a `height` property, for the viewer to extrude as an untextured 3D city model."""
    import shapely.geometry as sg

    from .osm import buildings_in

    out = cfg["paths"]["out_dir"]
    os.makedirs(out, exist_ok=True)
    e_right = mosaic.e_left + mosaic.cols * mosaic.cell
    n_top = mosaic.n_bottom + mosaic.rows * mosaic.cell
    sl = buildings_in(buildings, mosaic.e_left, mosaic.n_bottom, e_right, n_top).copy()
    # Drop tiny slivers and lightly simplify to keep the GeoJSON light.
    sl = sl[sl.geometry.area >= 20.0]
    sl["geometry"] = sl.geometry.simplify(1.0, preserve_topology=True)
    sl = sl[~sl.geometry.is_empty]
    sl4326 = sl.to_crs("EPSG:4326")

    feats = []
    for geom, h in zip(sl4326.geometry, sl4326.height):
        feats.append({"type": "Feature",
                      "geometry": sg.mapping(geom),
                      "properties": {"height": round(float(max(h, 2.0)), 1)}})
    _write_fc(os.path.join(out, "buildings.geojson"), feats)
    return len(feats)


def _write_fc(path, features):
    with open(path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)

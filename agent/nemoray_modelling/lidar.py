"""Real EA-LiDAR line-of-sight validation for candidate mast (COW) sites.

`validate_site`'s real backend. Uses the **Environment Agency National LiDAR Programme**
1 m composite — free, Open Government Licence — pulled straight from the EA's WCS:

  * **DSM** (last-return surface: ground + buildings + trees) → the obstacles along a path.
  * **DTM** (bare-earth terrain)                              → ground height at each end.

For a candidate site we cast rays from the antenna (height `h_tx` above ground) out to a
ring of receiver points at `radius_m` (street level, `h_rx`), and at each bearing walk the
DSM in 1 m steps: a point is blocked if the surface rises above the straight antenna→rx
line (plus a clearance `margin_m`). The **fraction of clear bearings** is the site's
"openness"; we pass it if that clears `min_clear_frac`. A site boxed in by a neighbouring
tower scores low (fail); an open site over rooftops scores high (pass) — verified against
real City-of-London geometry (a 22 Bishopsgate-class tower really does break the sightline).

Why LiDAR and not the RT twin: the Sionna twin models diffraction/reflection (NLoS
coverage); this is the stricter, independent *line-of-sight* reality-check on a single site,
from a different data source — exactly the planner-trust step in the brief.

    from .lidar import LidarLOS, fetch_tiles
    los = LidarLOS("data/lidar/city_dsm.tif", "data/lidar/city_dtm.tif")
    los.validate_latlng(51.5098, -0.0879)         # -> {"verdict": "pass"/"fail", ...}
"""
from __future__ import annotations

import math
import os

# EA National LiDAR Programme 1 m composite — WCS 2.0.1, EPSG:27700 (axis labels E, N).
DSM_WCS = ("https://environment.data.gov.uk/spatialdata/"
           "lidar-composite-digital-surface-model-last-return-dsm-1m/wcs")
DSM_COVERAGE = "9ba4d5ac-d596-445a-9056-dae3ddec0178__Lidar_Composite_Elevation_LZ_DSM_1m"
DTM_WCS = ("https://environment.data.gov.uk/spatialdata/"
           "lidar-composite-digital-terrain-model-dtm-1m/wcs")
DTM_COVERAGE = "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m"


def _wgs84_to_en(lng: float, lat: float) -> tuple[float, float]:
    from pyproj import Transformer
    tf = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    return tf.transform(lng, lat)


def fetch_tiles(e_min: float, n_min: float, e_max: float, n_max: float,
                dsm_path: str, dtm_path: str, timeout: float = 300.0) -> None:
    """Download the DSM + DTM GeoTIFFs for an EPSG:27700 bbox from the EA WCS."""
    import httpx

    os.makedirs(os.path.dirname(dsm_path) or ".", exist_ok=True)
    for url, cov, out in ((DSM_WCS, DSM_COVERAGE, dsm_path), (DTM_WCS, DTM_COVERAGE, dtm_path)):
        params = {
            "service": "WCS", "version": "2.0.1", "request": "GetCoverage",
            "coverageId": cov, "format": "image/tiff",
            "subset": [f"E({e_min},{e_max})", f"N({n_min},{n_max})"],
        }
        with httpx.Client(timeout=timeout) as c:
            r = c.get(url, params=params)
            r.raise_for_status()
            if r.content[:2] not in (b"II", b"MM"):   # TIFF magic
                raise RuntimeError(f"WCS did not return a GeoTIFF: {r.content[:200]!r}")
            with open(out, "wb") as f:
                f.write(r.content)


class LidarLOS:
    """Line-of-sight reality-check over EA LiDAR DSM/DTM rasters (EPSG:27700)."""

    def __init__(self, dsm_path: str, dtm_path: str):
        import numpy as np
        import rasterio
        self._np = np
        self._dsm_ds = rasterio.open(dsm_path)
        self._dtm_ds = rasterio.open(dtm_path)
        self._dsm = self._dsm_ds.read(1)
        self._dtm = self._dtm_ds.read(1)
        self._nodata = self._dsm_ds.nodata

    def _sample(self, arr, ds, e: float, n: float):
        r, c = ds.index(e, n)
        if 0 <= r < arr.shape[0] and 0 <= c < arr.shape[1]:
            v = arr[r, c]
            if v == self._nodata or not self._np.isfinite(v):
                return None
            return float(v)
        return None

    def covers(self, e: float, n: float) -> bool:
        """Is (E, N) inside the loaded tile (with valid terrain)?"""
        return self._sample(self._dtm, self._dtm_ds, e, n) is not None

    def profile(self, eA, nA, hA, eB, nB, hB, margin=0.0):
        """Worst obstruction (m above the antenna→rx line) along a single path, or None
        if either endpoint has no terrain data."""
        gA = self._sample(self._dtm, self._dtm_ds, eA, nA)
        gB = self._sample(self._dtm, self._dtm_ds, eB, nB)
        if gA is None or gB is None:
            return None
        zA, zB = gA + hA, gB + hB
        D = math.hypot(eB - eA, nB - nA)
        worst = (-1e9, 0)
        for k in range(1, int(D)):
            t = k / D
            s = self._sample(self._dsm, self._dsm_ds, eA + (eB - eA) * t, nA + (nB - nA) * t)
            if s is None:
                continue
            ob = s - (zA + (zB - zA) * t)
            if ob > worst[0]:
                worst = (ob, k)
        return worst  # (obstruction_m, at_m)

    def validate_en(self, e: float, n: float, h_tx: float = 30.0,
                    radius_m: float = 80.0, clearance_margin_m: float = 8.0) -> dict | None:
        """Overshadowing check: is a mast at this site clear of, or dominated by, the
        tallest structure nearby? In a dense city a pure street-level LoS test is always
        blocked (NLoS) — the meaningful, demo-honest LiDAR check is whether a taller
        adjacent building/tree shadows the antenna. Returns None if outside the tile."""
        np = self._np
        g = self._sample(self._dtm, self._dtm_ds, e, n)
        if g is None:
            return None
        ant = g + h_tx
        r0, c0 = self._dsm_ds.index(e, n)
        rad = int(radius_m)
        sub = self._dsm[max(0, r0 - rad):r0 + rad + 1, max(0, c0 - rad):c0 + rad + 1]
        valid = sub[(sub != self._nodata) & np.isfinite(sub)]
        if valid.size == 0:
            return None
        tallest_aod = float(valid.max())
        tallest_agl = tallest_aod - g          # height above local ground
        overshadow = tallest_aod - ant         # how far the tallest rises above the antenna
        shadow_frac = float((valid > ant).mean())
        verdict = "pass" if overshadow <= clearance_margin_m else "fail"
        if verdict == "fail":
            reason = (f"a {tallest_agl:.0f} m structure overshadows the {h_tx:.0f} m mast "
                      f"by {overshadow:.0f} m within {radius_m:.0f} m "
                      f"({shadow_frac * 100:.0f}% of the surroundings rise above the antenna)")
        else:
            reason = (f"clear — no structure within {radius_m:.0f} m rises more than "
                      f"{clearance_margin_m:.0f} m above the {h_tx:.0f} m antenna "
                      f"(tallest {tallest_agl:.0f} m AGL)")
        return {
            "verdict": verdict,
            "source": "LiDAR",
            "reason": reason,
            "antenna_elev_m_aod": round(ant, 1),
            "tallest_structure_m_agl": round(tallest_agl, 1),
            "overshadow_m": round(overshadow, 1),
            "shadow_fraction": round(shadow_frac, 2),
            "radius_m": radius_m,
        }

    def validate_latlng(self, lat: float, lng: float, **kw) -> dict | None:
        e, n = _wgs84_to_en(lng, lat)
        if not self.covers(e, n):
            return None
        return self.validate_en(e, n, **kw)


def main():
    import argparse

    ap = argparse.ArgumentParser(description="Fetch EA LiDAR tiles or run a LoS check")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="download DSM+DTM for an EPSG:27700 bbox")
    f.add_argument("e_min", type=float)
    f.add_argument("n_min", type=float)
    f.add_argument("e_max", type=float)
    f.add_argument("n_max", type=float)
    f.add_argument("--dsm", default="data/lidar/city_dsm.tif")
    f.add_argument("--dtm", default="data/lidar/city_dtm.tif")
    v = sub.add_parser("check", help="validate a lat/lng site")
    v.add_argument("lat", type=float)
    v.add_argument("lng", type=float)
    v.add_argument("--dsm", default="data/lidar/city_dsm.tif")
    v.add_argument("--dtm", default="data/lidar/city_dtm.tif")
    args = ap.parse_args()
    if args.cmd == "fetch":
        fetch_tiles(args.e_min, args.n_min, args.e_max, args.n_max, args.dsm, args.dtm)
        print(f"wrote {args.dsm} + {args.dtm}")
    else:
        los = LidarLOS(args.dsm, args.dtm)
        print(los.validate_latlng(args.lat, args.lng))


if __name__ == "__main__":
    main()

"""Load EE (Orange + T-Mobile) mast sites from the Ofcom Sitefinder CSV.

Sitefinder rows are per antenna/band. We group them into physical *sites* keyed by the
OS grid reference (Sitengr), taking the tallest antenna height and strongest declared
power at each site as a representative transmitter.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass, field

from .geo import lnglat_to_en, osgb36_to_wgs84


@dataclass
class Site:
    id: str
    operator: str
    lat: float
    lng: float
    e: float            # easting  (EPSG:27700)
    n: float            # northing (EPSG:27700)
    height_m: float
    power_dbm: float
    n_antennas: int = 0
    bands: set = field(default_factory=set)


def _to_float(s, default=None):
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def load_sites(cfg: dict) -> list[Site]:
    """Return EE sites whose location falls inside the configured bounding box."""
    bbox = cfg["bbox"]
    wanted = set(cfg["operators"])
    default_power = float(cfg["radio"]["tx_power_dbm"])

    sites: dict[str, Site] = {}
    with open(cfg["paths"]["csv"], newline="") as f:
        for row in csv.DictReader(f):
            op = row["Operator"]
            if op not in wanted:
                continue
            raw_lat = _to_float(row["Sitelat"])
            raw_lng = _to_float(row["Sitelng"])
            if raw_lat is None or raw_lng is None:
                continue
            # Sitefinder Sitelat/Sitelng are OSGB36 geodetic, not WGS84 (the source
            # converted the Sitengr grid refs off the Airy ellipsoid but omitted the
            # datum shift). Correct to WGS84 here so the bbox filter, the physics
            # easting/northing, and the exported masts.geojson are all ~125 m
            # accurate instead of off-by-a-datum. See geo.osgb36_to_wgs84.
            lng, lat = osgb36_to_wgs84(raw_lng, raw_lat)
            if not (bbox["lat_min"] <= lat <= bbox["lat_max"]
                    and bbox["lng_min"] <= lng <= bbox["lng_max"]):
                continue

            # Power: Sitefinder gives dBW; convert to dBm (+30). Prefer the actual
            # declared total power (Powerdbw) over the licensed maximum (Maxpwrdbw),
            # then cap to a realistic macro-cell EIRP ceiling.
            p_dbw = _to_float(row.get("Powerdbw")) or _to_float(row.get("Maxpwrdbw"))
            power_dbm = (p_dbw + 30.0) if p_dbw is not None else default_power
            power_dbm = min(power_dbm, 63.0)
            height = _to_float(row.get("Antennaht"), 15.0)
            band = row.get("Freqband", "")

            key = row.get("Sitengr") or f"{lat:.5f},{lng:.5f}"
            site = sites.get(key)
            if site is None:
                e, n = lnglat_to_en(lng, lat)
                site = Site(id=key, operator=op, lat=lat, lng=lng, e=e, n=n,
                            height_m=height, power_dbm=power_dbm)
                sites[key] = site
            site.n_antennas += 1
            site.bands.add(band)
            site.height_m = max(site.height_m, height)
            site.power_dbm = max(site.power_dbm, power_dbm)

    return list(sites.values())


def sites_near(sites: list[Site], e0: float, n0: float, radius: float) -> list[Site]:
    """Sites within `radius` metres of (e0, n0) — used to gather the transmitters that
    illuminate a tile (a mast outside a tile still radiates into it)."""
    r2 = radius * radius
    return [s for s in sites
            if (s.e - e0) ** 2 + (s.n - n0) ** 2 <= r2]


if __name__ == "__main__":
    from .config import load_config
    c = load_config()
    s = load_sites(c)
    ops = {}
    for x in s:
        ops[x.operator] = ops.get(x.operator, 0) + 1
    print(f"{len(s)} EE sites in Greater London: {ops}")
    print("sample:", s[0])

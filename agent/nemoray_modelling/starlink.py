"""Find the best Starlink satellite to connect to from a point at a time."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from skyfield.api import EarthSatellite, load, wgs84

from . import tle


@dataclass(frozen=True)
class SatelliteView:
    """A Starlink satellite as seen from an observer at one instant."""

    name: str
    norad_id: int
    sat_lat: float  # sub-satellite point latitude (deg)
    sat_lon: float  # sub-satellite point longitude (deg)
    altitude_km: float  # satellite height above ground (km)
    elevation_deg: float  # elevation angle from the observer (deg)
    azimuth_deg: float  # azimuth from the observer (deg, 0 = north)
    slant_range_km: float  # observer -> satellite distance (km)


_TIMESCALE = None


def _timescale():
    """Return a process-wide cached Skyfield timescale."""
    global _TIMESCALE
    if _TIMESCALE is None:
        _TIMESCALE = load.timescale()
    return _TIMESCALE


def _require_utc(when: datetime) -> datetime:
    if when.tzinfo is None or when.tzinfo.utcoffset(when) is None:
        raise ValueError("`when` must be a timezone-aware UTC datetime")
    return when


def visible_satellites(
    lat: float,
    lon: float,
    when: datetime,
    *,
    min_elevation_deg: float = 25.0,
    tles: list[EarthSatellite] | None = None,
    ts=None,
) -> list[SatelliteView]:
    """All Starlink satellites at/above the mask, sorted by slant range."""
    when = _require_utc(when)
    ts = ts or _timescale()
    if tles is None:
        tles = tle.load_starlink_tles(ts=ts)

    observer = wgs84.latlon(lat, lon)
    t = ts.from_datetime(when)

    views: list[SatelliteView] = []
    for sat in tles:
        alt, az, distance = (sat - observer).at(t).altaz()
        if alt.degrees < min_elevation_deg:
            continue
        subpoint = wgs84.subpoint(sat.at(t))
        views.append(
            SatelliteView(
                name=sat.name or "",
                norad_id=int(sat.model.satnum),
                sat_lat=subpoint.latitude.degrees,
                sat_lon=subpoint.longitude.degrees,
                altitude_km=subpoint.elevation.km,
                elevation_deg=alt.degrees,
                azimuth_deg=az.degrees,
                slant_range_km=distance.km,
            )
        )

    views.sort(key=lambda v: v.slant_range_km)
    return views


def best_satellite(
    lat: float,
    lon: float,
    when: datetime,
    *,
    min_elevation_deg: float = 25.0,
    tles: list[EarthSatellite] | None = None,
    ts=None,
) -> SatelliteView | None:
    """The connectable satellite with the smallest slant range, or None."""
    views = visible_satellites(
        lat, lon, when, min_elevation_deg=min_elevation_deg, tles=tles, ts=ts
    )
    return views[0] if views else None

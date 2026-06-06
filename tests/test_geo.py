"""Coordinate-transform regression tests.

The Sitefinder CSV publishes its mast coordinates in OSGB36 degrees, not WGS84.
Feeding those straight into the WGS84->BNG transform places masts ~125 m from
their true grid position, so the RT solve traced from the wrong spot. These tests
pin the datum correction (geo.osgb36_to_wgs84) and prove the corrected coordinates
round-trip to the canonical National Grid reference.
"""
import math

from src.geo import lnglat_to_en, osgb36_to_wgs84


def _haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p = math.pi / 180
    dlat = (lat2 - lat1) * p
    dlng = (lng2 - lng1) * p
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin(dlng / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


# CSV (OSGB36) coordinates for Sitengr TQ3225075840 == E532250 N175840 (EPSG:27700).
_OSGB36_LAT, _OSGB36_LNG = 51.46557, -0.095904
_TRUE_E, _TRUE_N = 532250.0, 175840.0


def test_osgb36_to_wgs84_shifts_north_west():
    lng, lat = osgb36_to_wgs84(_OSGB36_LNG, _OSGB36_LAT)
    # True WGS84 position is ~125 m to the WNW: latitude rises, longitude drops.
    assert lat > _OSGB36_LAT
    assert lng < _OSGB36_LNG
    shift = _haversine_m(_OSGB36_LAT, _OSGB36_LNG, lat, lng)
    assert 118 < shift < 132


def test_corrected_coords_round_trip_to_grid_ref():
    """Correcting the datum then projecting to BNG reproduces the Sitengr ref."""
    lng, lat = osgb36_to_wgs84(_OSGB36_LNG, _OSGB36_LAT)
    e, n = lnglat_to_en(lng, lat)
    assert abs(e - _TRUE_E) < 1.0
    assert abs(n - _TRUE_N) < 1.0


def test_uncorrected_coords_are_off_by_a_datum():
    """The old path (OSGB36 degrees treated as WGS84) lands ~125 m off-grid."""
    e, n = lnglat_to_en(_OSGB36_LNG, _OSGB36_LAT)
    assert math.hypot(e - _TRUE_E, n - _TRUE_N) > 100

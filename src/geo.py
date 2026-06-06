"""Coordinate transforms (WGS84 <-> British National Grid) and the London tile grid.

Everything in the physics pipeline is done in EPSG:27700 (metres). A scene tile has a
local origin at its centre (e0, n0); local mesh/transmitter coordinates are simply
(E - e0, N - n0, z) with x=East, y=North, z=Up — which matches Sionna RT's convention.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from pyproj import Transformer

# always_xy=True => inputs/outputs are ordered (lng, lat) / (easting, northing).
_FWD = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
_INV = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def lnglat_to_en(lng, lat):
    """WGS84 -> British National Grid metres. Scalars or arrays."""
    return _FWD.transform(lng, lat)


def en_to_lnglat(e, n):
    """British National Grid metres -> WGS84. Returns (lng, lat)."""
    return _INV.transform(e, n)


@dataclass
class Tile:
    ix: int          # column index in the grid
    iy: int          # row index in the grid
    e0: float        # centre easting (m, EPSG:27700)
    n0: float        # centre northing (m)
    size: float      # tile edge (m)

    @property
    def key(self) -> str:
        # Location-based key so different subsets/grids never collide in the tile cache
        # (a 2 km tile centre is unique to ~1 m).
        return f"tile_{int(round(self.e0))}_{int(round(self.n0))}"

    def bounds_en(self, margin: float = 0.0):
        """(e_min, n_min, e_max, n_max) of the tile, optionally grown by `margin`."""
        h = self.size / 2 + margin
        return (self.e0 - h, self.n0 - h, self.e0 + h, self.n0 + h)


def grid_for_bbox(bbox: dict, tile_size: float) -> list[Tile]:
    """Tile the lat/lng bounding box. Tiles are laid out on the 27700 grid so they
    align cleanly across the whole area (important for a seamless mosaic)."""
    e_sw, n_sw = lnglat_to_en(bbox["lng_min"], bbox["lat_min"])
    e_ne, n_ne = lnglat_to_en(bbox["lng_max"], bbox["lat_max"])
    e_min, e_max = sorted((e_sw, e_ne))
    n_min, n_max = sorted((n_sw, n_ne))
    # Snap origin to a multiple of tile_size for reproducible tiling.
    e_start = math.floor(e_min / tile_size) * tile_size
    n_start = math.floor(n_min / tile_size) * tile_size
    tiles = []
    iy = 0
    n = n_start
    while n < n_max:
        ix = 0
        e = e_start
        while e < e_max:
            tiles.append(Tile(ix, iy, e + tile_size / 2, n + tile_size / 2, tile_size))
            e += tile_size
            ix += 1
        n += tile_size
        iy += 1
    return tiles


def tiles_for_subset(center_latlng, n_tiles: int, tile_size: float) -> list[Tile]:
    """A small n_tiles x n_tiles block of tiles centred on a lat/lng — for fast demos."""
    lat, lng = center_latlng
    ce, cn = lnglat_to_en(lng, lat)
    half = (n_tiles - 1) / 2.0
    tiles = []
    for j in range(n_tiles):
        for i in range(n_tiles):
            e0 = ce + (i - half) * tile_size
            n0 = cn + (j - half) * tile_size
            tiles.append(Tile(i, j, e0, n0, tile_size))
    return tiles

"""Stitch per-tile dBm rasters into one Greater-London coverage grid (EPSG:27700).

Tiles share a common cell size and are snapped to the metric grid, so combining is a
max-merge of best-server RSS at aligned cell offsets. Also derives low-coverage hotspot
polygons (simulated cells whose best-server RSS is below the service threshold).
"""
from __future__ import annotations

import numpy as np

from .rt import NODATA


class Mosaic:
    def __init__(self, cell: float):
        self.cell = float(cell)
        self._tiles = []           # list of result dicts from rt.solve_tile

    def add(self, res: dict):
        if res is not None:
            self._tiles.append(res)

    def assemble(self):
        """Build (dbm grid, simulated mask, transform). Transform maps col/row -> (E, N)
        of the cell's lower-left, with row 0 at the south edge."""
        if not self._tiles:
            raise ValueError("no tiles to assemble")
        cell = self.cell
        e_left = min(t["e_left"] for t in self._tiles)
        n_bottom = min(t["n_bottom"] for t in self._tiles)
        e_right = max(t["e_left"] + t["cols"] * cell for t in self._tiles)
        n_top = max(t["n_bottom"] + t["rows"] * cell for t in self._tiles)

        cols = int(round((e_right - e_left) / cell))
        rows = int(round((n_top - n_bottom) / cell))
        grid = np.full((rows, cols), NODATA, dtype=np.float32)
        mask = np.zeros((rows, cols), dtype=bool)

        for t in self._tiles:
            cx = int(round((t["e_left"] - e_left) / cell))
            cy = int(round((t["n_bottom"] - n_bottom) / cell))
            sub = t["dbm"]
            r, c = sub.shape
            grid[cy:cy + r, cx:cx + c] = np.maximum(grid[cy:cy + r, cx:cx + c], sub)
            mask[cy:cy + r, cx:cx + c] = True

        self.dbm = grid
        self.mask = mask
        self.e_left = e_left
        self.n_bottom = n_bottom
        self.cols = cols
        self.rows = rows
        return grid, mask

    def sample(self, e: float, n: float) -> float:
        """Best-server dBm at a point (EPSG:27700), or NODATA if outside the grid."""
        col = int((e - self.e_left) / self.cell)
        row = int((n - self.n_bottom) / self.cell)
        if 0 <= row < self.rows and 0 <= col < self.cols:
            return float(self.dbm[row, col])
        return NODATA

    def transform(self):
        """rasterio Affine: north-up (row 0 at the top), origin at the NW corner."""
        from rasterio.transform import from_origin
        n_top = self.n_bottom + self.rows * self.cell
        return from_origin(self.e_left, n_top, self.cell, self.cell)

    def dbm_northup(self):
        """dBm grid flipped so row 0 is the north edge (raster/image convention)."""
        return np.flipud(self.dbm)

    def hotspots(self, served_threshold: float):
        """Low-coverage polygons in EPSG:27700, as a list of (geometry, props)."""
        import shapely.geometry as sg
        from rasterio import features

        low = self.mask & (self.dbm < served_threshold)
        if not low.any():
            return []
        # Use the north-up grid + transform for correct georeferencing.
        low_nu = np.flipud(low).astype(np.uint8)
        out = []
        for geom, val in features.shapes(low_nu, mask=low_nu.astype(bool),
                                          transform=self.transform()):
            if val == 1:
                poly = sg.shape(geom)
                if poly.area >= self.cell * self.cell:   # drop single stray cells
                    out.append(poly)
        return out

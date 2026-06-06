"""Sionna RT per-tile solve: radio map (coverage) + optional ray paths.

Coverage is best-server received signal strength (RSS) in dBm over the tile's inner
2 km square. Transmitters are every EE mast within `tx_radius` of the tile centre, so a
mast just outside a tile still contributes coverage inside it.
"""
from __future__ import annotations

import numpy as np

# Sionna RT picks a Mitsuba variant on import; cuda_ad_* is selected automatically when a
# GPU is present. Importing here keeps the heavy import out of the lightweight modules.
import sionna.rt as rt
from sionna.rt import (PathSolver, PlanarArray, RadioMapSolver, Receiver,
                       Transmitter, load_scene)

from .geo import Tile
from .masts import Site, sites_near

NODATA = -300.0  # dBm sentinel for "no signal computed"


def _configure(scene, cfg, sites_local):
    """Attach arrays + transmitters to a freshly loaded scene."""
    scene.frequency = float(cfg["radio"]["carrier_hz"])
    scene.tx_array = PlanarArray(num_rows=1, num_cols=1, pattern="tr38901",
                                 polarization="V")
    scene.rx_array = PlanarArray(num_rows=1, num_cols=1, pattern="iso",
                                 polarization="V")
    for i, (s, x, y) in enumerate(sites_local):
        scene.add(Transmitter(name=f"tx{i}", position=[x, y, float(s.height_m)],
                              power_dbm=float(s.power_dbm)))


def _local_sites(tile: Tile, sites, radius):
    """Sites within `radius` of the tile centre, expressed in the tile-local frame."""
    near = sites_near(sites, tile.e0, tile.n0, radius)
    return [(s, s.e - tile.e0, s.n - tile.n0) for s in near]


def solve_tile(cfg: dict, tile: Tile, xml_path: str, sites: list[Site]) -> dict | None:
    """Run the radio-map solver for a tile. Returns a dict with the dBm grid and its
    27700 georeference, or None if no transmitters illuminate the tile."""
    r = cfg["radio"]
    tx_radius = tile.size / 2 + cfg["tiling"].get("tx_radius_m", 1500.0)
    sites_local = _local_sites(tile, sites, tx_radius)
    if not sites_local:
        return None

    scene = load_scene(xml_path)
    _configure(scene, cfg, sites_local)

    rms = RadioMapSolver()
    rm = rms(scene,
             center=[0.0, 0.0, r["rx_height_m"]],
             size=[tile.size, tile.size],
             orientation=[0.0, 0.0, 0.0],
             cell_size=[r["cell_size_m"], r["cell_size_m"]],
             max_depth=int(r["max_depth"]),
             samples_per_tx=int(r["samples_per_tx"]),
             diffraction=True, refraction=True)

    # rss: (num_tx, rows, cols) in Watts. Best-server coverage = max over transmitters.
    rss_w = rm.rss.numpy()
    best_w = rss_w.max(axis=0)
    with np.errstate(divide="ignore"):
        dbm = 10.0 * np.log10(best_w) + 30.0
    dbm = np.where(np.isfinite(dbm), dbm, NODATA).astype(np.float32)

    # Georeference: the map is axis-aligned in the local frame, centred at the origin and
    # spanning [-size/2, size/2]. cell_centers are (rows, cols, 3) local coords; row index
    # increases with North, col index with East.
    cc = rm.cell_centers.numpy()
    rows, cols = dbm.shape
    e_left = tile.e0 + cc[0, 0, 0]
    n_bottom = tile.n0 + cc[0, 0, 1]
    cell = float(r["cell_size_m"])
    return {
        "tile": tile.key,
        "dbm": dbm,                # (rows, cols), row 0 = south
        "e_left": e_left - cell / 2,
        "n_bottom": n_bottom - cell / 2,
        "cell": cell,
        "rows": rows,
        "cols": cols,
        "n_tx": len(sites_local),
    }


def trace_mast_rays(cfg: dict, tile: Tile, xml_path: str, masts: list[Site],
                    ring: int = 9, ring_radius: float = 120.0,
                    max_lines: int = 10 ** 9) -> list[dict]:
    """Trace ALL ray paths out of every given mast (LOS + every reflection/diffraction
    found to a ring of receivers around each mast), for 3D visualisation. The scene is
    loaded once and the single transmitter + its receiver ring are repositioned per mast,
    so this stays fast over hundreds of masts. Returns dicts with WGS84 polyline coords,
    the operator, and the number of building bounces."""
    from .geo import en_to_lnglat

    if not masts:
        return []
    scene = load_scene(xml_path)
    scene.frequency = float(cfg["radio"]["carrier_hz"])
    scene.tx_array = PlanarArray(num_rows=1, num_cols=1, pattern="tr38901", polarization="V")
    scene.rx_array = PlanarArray(num_rows=1, num_cols=1, pattern="iso", polarization="V")
    rxh = float(cfg["radio"]["rx_height_m"])
    max_depth = int(cfg["radio"]["max_depth"])

    tx = Transmitter(name="tx", position=[0.0, 0.0, 30.0], power_dbm=46.0)
    scene.add(tx)
    rxs = []
    for k in range(ring):
        rx = Receiver(name=f"rx{k}", position=[0.0, 0.0, rxh])
        scene.add(rx)
        rxs.append(rx)

    ps = PathSolver()
    out = []
    for s in masts:
        x = float(s.e - tile.e0)
        y = float(s.n - tile.n0)
        h = float(s.height_m)
        tx.position = [x, y, h]
        for k, rx in enumerate(rxs):
            a = 2 * np.pi * k / ring
            rx.position = [x + float(ring_radius * np.cos(a)),
                           y + float(ring_radius * np.sin(a)), rxh]

        paths = ps(scene, max_depth=max_depth, los=True,
                   specular_reflection=True, diffraction=True, refraction=True)
        verts = paths.vertices.numpy()    # (depth, ring, 1, n_p, 3)
        valid = paths.valid.numpy()       # (ring, 1, n_p)
        inter = paths.interactions.numpy()
        tgt = paths.targets.numpy().T     # (ring, 3)
        depth, n_rx, _, n_p, _ = verts.shape
        src_world = [x, y, h]

        for rxi in range(n_rx):
            for pi in range(n_p):
                if not valid[rxi, 0, pi]:
                    continue
                pts = [src_world]
                for d in range(depth):
                    if inter[d, rxi, 0, pi] == 0:
                        continue
                    pts.append(verts[d, rxi, 0, pi])
                pts.append(tgt[rxi])
                coords = []
                for p in pts:
                    lng, lat = en_to_lnglat(tile.e0 + p[0], tile.n0 + p[1])
                    # Round to ~0.1 m / 0.1 m to keep the (large) GeoJSON compact.
                    coords.append([round(float(lng), 6), round(float(lat), 6),
                                   round(float(max(p[2], 0.0)), 1)])
                out.append({"coords": coords, "operator": s.operator,
                            "bounces": len(coords) - 2})
        if len(out) >= max_lines:
            break
    return out

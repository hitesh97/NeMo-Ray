"""Build a Sionna-RT/Mitsuba scene for one tile from an OSM building slice.

Footprints (EPSG:27700) are translated into the tile's local frame (origin at tile
centre, x=East, y=North, z=Up), extruded to their height, merged into a single mesh,
and written as a PLY. A flat ground plane is added. A Mitsuba XML wires the meshes to
ITU radio materials that Sionna understands.
"""
from __future__ import annotations

import os

import numpy as np
import trimesh
from shapely.geometry import MultiPolygon, Polygon

from . import osm
from .geo import Tile

# Mitsuba XML template. `itu-radio-material` is Sionna RT's BSDF plugin; `type` selects
# the ITU-R P.2040 material parameters.
_XML = """<scene version="2.1.0">
  <bsdf type="itu-radio-material" id="mat-building">
    <string name="type" value="concrete"/>
    <float name="thickness" value="0.3"/>
  </bsdf>
  <bsdf type="itu-radio-material" id="mat-ground">
    <string name="type" value="medium_dry_ground"/>
    <float name="thickness" value="0.1"/>
  </bsdf>
{shapes}
</scene>
"""

_SHAPE = """  <shape type="ply" id="{sid}">
    <string name="filename" value="{fname}"/>
    <boolean name="face_normals" value="true"/>
    <ref id="{mat}" name="bsdf"/>
  </shape>"""


def _extrude(poly: Polygon, height: float):
    """Extrude a 2D polygon to a solid prism mesh, or None if degenerate."""
    if poly.is_empty or poly.area < 1.0:   # drop sub-1 m^2 slivers
        return None
    height = max(float(height), 2.0)       # clamp bad/negative OSM height tags
    try:
        m = trimesh.creation.extrude_polygon(poly, height=height)
    except Exception:
        return None
    if m is None or m.faces.shape[0] == 0:
        return None
    return m


def build_tile_scene(cfg: dict, tile: Tile, buildings) -> tuple[str, int]:
    """Write meshes + Mitsuba XML for a tile. Returns (xml_path, n_buildings)."""
    margin = cfg["tiling"]["margin_m"]
    e_min, n_min, e_max, n_max = tile.bounds_en(margin)
    slice_ = osm.buildings_in(buildings, e_min, n_min, e_max, n_max)

    tdir = os.path.join(cfg["paths"]["data_dir"], "tiles", tile.key)
    mdir = os.path.join(tdir, "meshes")
    os.makedirs(mdir, exist_ok=True)

    # Extrude every footprint, translated into the local frame.
    meshes = []
    for geom, height in zip(slice_.geometry, slice_.height):
        polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
        for poly in polys:
            # Translate exterior+holes to local coords before extruding.
            local = _translate(poly, tile.e0, tile.n0)
            m = _extrude(local, height)
            if m is not None:
                meshes.append(m)

    shapes = []
    if meshes:
        combined = trimesh.util.concatenate(meshes)
        bpath = os.path.join(mdir, "buildings.ply")
        combined.export(bpath)
        shapes.append(_SHAPE.format(sid="mesh-buildings",
                                    fname="meshes/buildings.ply", mat="mat-building"))

    # Flat ground plane spanning the tile+margin.
    half = tile.size / 2 + margin
    ground = trimesh.Trimesh(
        vertices=np.array([[-half, -half, 0.0], [half, -half, 0.0],
                           [half, half, 0.0], [-half, half, 0.0]]),
        faces=np.array([[0, 1, 2], [0, 2, 3]]))
    gpath = os.path.join(mdir, "ground.ply")
    ground.export(gpath)
    shapes.append(_SHAPE.format(sid="mesh-terrain",
                                fname="meshes/ground.ply", mat="mat-ground"))

    xml_path = os.path.join(tdir, f"{tile.key}.xml")
    with open(xml_path, "w") as f:
        f.write(_XML.format(shapes="\n".join(shapes)))
    return xml_path, len(meshes)


def _translate(poly: Polygon, e0: float, n0: float) -> Polygon:
    ext = [(x - e0, y - n0) for x, y in poly.exterior.coords]
    holes = [[(x - e0, y - n0) for x, y in r.coords] for r in poly.interiors]
    return Polygon(ext, holes)

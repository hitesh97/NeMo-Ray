"""Greater-London 4G coverage digital twin (Phase 1).

Pipeline: EE masts (Sitefinder) + OSM 3D buildings -> per-tile Sionna RT radio maps
-> mosaic -> Cesium 3D viewer.

All projected geometry uses EPSG:27700 (British National Grid), reprojected to
WGS84 (EPSG:4326) only for the final web export.
"""

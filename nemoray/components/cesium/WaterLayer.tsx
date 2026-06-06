'use client';
import { useEffect } from 'react';
import * as Cesium from 'cesium';
import { useCesiumViewer } from './CesiumContext';

/**
 * The Thames (plus the Docklands basins, Surrey/Greenwich docks and notable
 * lakes) rendered as a coloured water sheet on the dark globe ground.
 *
 * The OSM building twin (RayTracingLayer) is intentionally untextured and dark,
 * so on its own the river reads as just more dark ground. This layer paints the
 * water bodies a distinct deep blue so the iconic Thames meander anchors the
 * scene and the city massing has something to read against.
 *
 * Geometry is a static OSM extract (natural=water / waterway=riverbank for the
 * London view) baked to /geo/thames.geojson — it never changes between Sionna
 * runs, so unlike the RT layers it loads once and is not polled. Polygons are
 * clamped to the globe ground (z = 0, the same street-level frame the whole twin
 * shares) and drawn as a translucent fill, so the extruded buildings still rise
 * cleanly out of the riverbanks.
 */

const DATA = '/geo/thames.geojson';

// Deep luminous water-blue: clearly distinct from the dark #11151c ground and
// the building blue-greys, while staying clear of the cyan rays (#21d4fd) and
// the green coverage drape so each layer keeps its own identity in dark mode.
const WATER_COLOR = '#0e4f7e';
const WATER_ALPHA = 0.62;

export default function WaterLayer(): null {
  const viewer = useCesiumViewer();

  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    let dataSource: Cesium.GeoJsonDataSource | null = null;

    const material = new Cesium.ColorMaterialProperty(
      Cesium.Color.fromCssColorString(WATER_COLOR).withAlpha(WATER_ALPHA)
    );

    Cesium.GeoJsonDataSource.load(DATA, { clampToGround: true })
      .then((ds) => {
        if (cancelled) return;
        ds.entities.values.forEach((ent) => {
          if (!ent.polygon) return;
          ent.polygon.material = material;
          ent.polygon.outline = new Cesium.ConstantProperty(false);
          // Drape on the globe ground only (not over the buildings), so the
          // river sits at street level and the city extrudes out of it.
          ent.polygon.classificationType = new Cesium.ConstantProperty(
            Cesium.ClassificationType.TERRAIN
          );
          ent.polygon.height = undefined;
        });
        dataSource = ds;
        return viewer.dataSources.add(ds);
      })
      .then(() => {
        if (!cancelled) viewer.scene.requestRender();
      })
      .catch((error) => {
        console.warn('WaterLayer: Thames load failed', error);
      });

    return () => {
      cancelled = true;
      if (dataSource && !viewer.isDestroyed()) {
        viewer.dataSources.remove(dataSource, true);
      }
    };
  }, [viewer]);

  return null;
}

'use client';
import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { useCesiumViewer } from './CesiumContext';

/**
 * Renders the Sionna RT pipeline output (src/export.py → config.yaml out_dir →
 * nemoray/public/raytracing/, served at /raytracing/*) onto the live Cesium scene:
 *
 *   - buildings  the OSM building twin (buildings.geojson) extruded from the globe
 *                ground — the city geometry the rays were actually traced against
 *   - rays       traced ray polylines (paths.geojson) as one batched LINES primitive
 *   - coverage   the dBm heatmap (coverage.png) draped on the globe as an imagery layer
 *   - holes      low-coverage hotspot polygons (hotspots.geojson)
 *   - proposals  cuOpt-proposed masts + their recomputed rays (new_masts/new_rays.geojson)
 *
 * It polls summary.json and rebuilds whenever the pipeline republishes, so a fresh
 * `python -m src.pipeline` run shows up in the dashboard with no reload. Masts are
 * intentionally omitted — the dashboard already has the live Sitefinder tower layer.
 *
 * Datum note: the whole twin lives in ONE flat frame where z = 0 is street level
 * (the pipeline builds every tile with ground_z_m = 0). We render it onto the dark
 * untextured globe whose surface IS z = 0, so there is NO datum offset — buildings
 * extrude from 0, rays draw at their true z, the coverage heatmap drapes on the
 * globe ground, and everything lines up exactly the way Sionna computed it. (The
 * old Google Photorealistic 3D Tiles world sat ~+46 m up and forced a sampled
 * offset hack; removing the tiles removes the hack.)
 */

const DATA = '/raytracing';
const RAY_COLOR = '#21d4fd';
const NEW_COLOR = '#ffd23f';
const HOLE_COLOR = '#ff2d2d';

// Coverage heatmap drape: laid on the globe ground as a translucent imagery layer
// (matching the standalone OSM twin, viewer/app.js) so the extruded OSM buildings
// rise out of it cleanly and the city reads through the greens.
const COVERAGE_ALPHA = 0.8;

// The OSM building twin the ray-tracing was computed on, rendered as a solid
// untextured city. Default height when OSM tagged none (~3 storeys, matches the
// pipeline's buildings.default_height_m).
const BUILDING_DEFAULT_H = 9;
const BUILDING_ALPHA = 1.0;

export type RayLayerKey = 'rays' | 'coverage' | 'holes' | 'proposals' | 'buildings';
export type RayTracingShow = Record<RayLayerKey, boolean>;

export interface RtSummary {
  served_pct?: number;
  low_coverage_polys?: number;
  ray_paths?: number;
  sites_total?: number;
  performance?: { device?: string; ray_trace?: { count?: number; rays_per_s?: number } };
  [key: string]: unknown;
}

interface LayerHandle {
  setShow: (visible: boolean) => void;
  destroy: () => void;
}

const NOOP: LayerHandle = { setShow: () => {}, destroy: () => {} };

interface RayTracingLayerProps {
  show: RayTracingShow;
  /** How often (ms) to poll summary.json for a fresh pipeline run. 0 disables polling. */
  pollMs?: number;
  onSummary?: (summary: RtSummary | null) => void;
}

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json() as Promise<T>;
}

// The whole OSM twin (buildings, rays, coverage, proposals) lives in one flat frame
// where z = 0 is street level (the pipeline builds every tile with ground_z_m = 0).
// We render that frame directly onto the untextured globe, whose surface IS z = 0,
// so the shared offset is simply 0 — no tile-height sampling, no datum hack. Kept as
// a named constant so every builder reads from the same single source of truth.
const GROUND_OFFSET = 0;

interface LineFeatureCollection {
  features: { geometry: { coordinates: number[][] } }[];
}

interface BuildingFeatureCollection {
  features: {
    geometry: { type: string; coordinates: number[][][] | number[][][][] };
    properties: { height?: number };
  }[];
}

// The OSM building twin, extruded as batched 3D primitives and lifted onto the
// photorealistic street level (the shared `offset`) so the rays demonstrably
// originate from and bounce off the same geometry they were traced against.
// Chunked so one bad polygon can't drop the whole city and it paints progressively.
function buildBuildings(
  fc: BuildingFeatureCollection,
  offset: number,
  scene: Cesium.Scene
): LayerHandle {
  const instances: Cesium.GeometryInstance[] = [];
  for (const f of fc.features) {
    const h = f.properties.height || BUILDING_DEFAULT_H;
    const polys =
      f.geometry.type === 'MultiPolygon'
        ? (f.geometry.coordinates as number[][][][])
        : [f.geometry.coordinates as number[][][]];
    for (const rings of polys) {
      const ext = rings[0];
      if (!ext || ext.length < 4) continue;
      const flat: number[] = [];
      for (const c of ext) flat.push(c[0], c[1]);
      const t = Math.min(h / 80, 1);
      // Brighter base + stronger height ramp so the city massing reads boldly
      // against the dark globe ground and the new coloured Thames, instead of
      // melting into the near-black basemap (was 0.32 + 0.34·t).
      const shade = 0.46 + 0.42 * t; // taller → lighter
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
            height: offset,
            extrudedHeight: offset + h,
            closeTop: true,
            closeBottom: false,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              new Cesium.Color(shade * 0.78, shade * 0.88, shade * 1.06, BUILDING_ALPHA)
            ),
          },
        })
      );
    }
  }
  if (!instances.length) return NOOP;

  const CHUNK = 4000;
  const prims: Cesium.Primitive[] = [];
  for (let i = 0; i < instances.length; i += CHUNK) {
    const p = new Cesium.Primitive({
      geometryInstances: instances.slice(i, i + CHUNK),
      appearance: new Cesium.PerInstanceColorAppearance({ flat: false, translucent: BUILDING_ALPHA < 1 }),
      asynchronous: false,
    });
    scene.primitives.add(p);
    prims.push(p);
  }
  return {
    setShow: (v) => prims.forEach((p) => (p.show = v)),
    destroy: () => prims.forEach((p) => scene.primitives.remove(p)),
  };
}

// Every traced ray as one batched LINES primitive in a single translucent colour —
// the only way to draw hundreds of thousands of segments without melting the GPU.
function buildLines(
  fc: LineFeatureCollection,
  cssColor: string,
  alpha: number,
  offset: number,
  scene: Cesium.Scene
): LayerHandle {
  const vals: number[] = [];
  for (const f of fc.features) {
    const cs = f.geometry.coordinates;
    const carts = cs.map((c) => Cesium.Cartesian3.fromDegrees(c[0], c[1], Math.max(c[2], 0) + offset));
    for (let i = 0; i < carts.length - 1; i++) {
      const a = carts[i];
      const b = carts[i + 1];
      vals.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  if (!vals.length) return NOOP;

  const geometry = new Cesium.Geometry({
    // Cesium's GeometryAttributes typing marks every channel required; a LINES
    // primitive only needs position, so cast past the over-strict type.
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: new Float64Array(vals),
      }),
    } as unknown as Cesium.GeometryAttributes,
    primitiveType: Cesium.PrimitiveType.LINES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(vals),
  });
  const prim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
          Cesium.Color.fromCssColorString(cssColor).withAlpha(alpha)
        ),
      },
    }),
    // Draw the rays as a visualisation overlay: depth-test off so they read clearly
    // from any angle instead of being swallowed by the photorealistic buildings
    // (the scene lands at a low, oblique view where opaque tiles would hide them).
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      renderState: {
        depthTest: { enabled: false },
        depthMask: false,
        blending: Cesium.BlendingState.ALPHA_BLEND,
      },
    }),
    asynchronous: false,
  });
  scene.primitives.add(prim);
  return {
    setShow: (v) => {
      prim.show = v;
    },
    destroy: () => {
      scene.primitives.remove(prim);
    },
  };
}

interface CoverageBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

// The coverage heatmap PNG draped on the globe ground as a single-tile imagery
// layer (the standalone OSM twin's approach, viewer/app.js:157-166). With the globe
// back as the world surface this is a true ground drape — the heatmap follows z = 0
// exactly and the extruded OSM buildings rise out of it — so no flat-plane height
// fudge is needed. Translucent so the city reads through the greens.
async function buildCoverage(bounds: CoverageBounds, sig: string, viewer: Cesium.Viewer): Promise<LayerHandle> {
  try {
    const rectangle = Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north);
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(`${DATA}/coverage.png?t=${sig}`, {
      rectangle,
    });
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = COVERAGE_ALPHA;
    return {
      setShow: (v) => {
        layer.show = v;
      },
      destroy: () => {
        if (!viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true);
      },
    };
  } catch (error) {
    console.warn('RayTracingLayer: coverage drape failed', error);
    return NOOP;
  }
}

// Low-coverage holes as ground-classified red polygons (per-instance colour, which
// classification supports on 3D tiles even where textured drapes don't).
async function buildHoles(sig: string, viewer: Cesium.Viewer): Promise<LayerHandle> {
  const ds = await Cesium.GeoJsonDataSource.load(`${DATA}/hotspots.geojson?t=${sig}`, {
    clampToGround: true,
  });
  ds.entities.values.forEach((ent) => {
    if (ent.polygon) {
      ent.polygon.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(HOLE_COLOR).withAlpha(0.5)
      );
      ent.polygon.outline = new Cesium.ConstantProperty(false);
      ent.polygon.classificationType = new Cesium.ConstantProperty(Cesium.ClassificationType.BOTH);
      ent.polygon.height = undefined;
    }
  });
  await viewer.dataSources.add(ds);
  return {
    setShow: (v) => {
      ds.show = v;
    },
    destroy: () => {
      viewer.dataSources.remove(ds, true);
    },
  };
}

interface ProposalFeatureCollection {
  features: {
    geometry: { coordinates: [number, number] };
    properties: { id?: string; height_m?: number; radius_m?: number; covers_holes?: number };
  }[];
}

// cuOpt-proposed masts: a ground-classified coverage footprint + a gold tower and
// node, plus their recomputed rays as a second (gold) batched LINES primitive.
async function buildProposals(sig: string, offset: number, viewer: Cesium.Viewer): Promise<LayerHandle> {
  const gold = Cesium.Color.fromCssColorString(NEW_COLOR);
  const ds = new Cesium.CustomDataSource('rt-proposals');
  const fc = await fetchJSON<ProposalFeatureCollection>(`${DATA}/new_masts.geojson?t=${sig}`);
  for (const f of fc.features) {
    const [lng, lat] = f.geometry.coordinates;
    const p = f.properties;
    const h = p.height_m ?? 25;
    const r = p.radius_m ?? 280;
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng, lat, 0),
      ellipse: {
        semiMajorAxis: r,
        semiMinorAxis: r,
        // Outlines are unsupported on ground-classified geometry, so keep the
        // footprint as a filled, slightly stronger disc instead of an outline.
        material: gold.withAlpha(0.14),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([lng, lat, offset, lng, lat, h + offset]),
        width: 2.5,
        material: gold,
        arcType: Cesium.ArcType.NONE,
      },
    });
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng, lat, h + offset),
      point: {
        pixelSize: 11,
        color: gold,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      description: `<b>Proposed mast (cuOpt)</b><br/>id: ${p.id ?? '?'}<br/>height: ${h} m<br/>serves ${
        p.covers_holes ?? 0
      } hole(s) within ${r} m`,
    });
  }
  await viewer.dataSources.add(ds);

  let newRays: LayerHandle | null = null;
  try {
    const rfc = await fetchJSON<LineFeatureCollection>(`${DATA}/new_rays.geojson?t=${sig}`);
    newRays = buildLines(rfc, NEW_COLOR, 0.32, offset, viewer.scene);
  } catch {
    // new_rays only exists after an optimise run — fine to skip
  }

  return {
    setShow: (v) => {
      ds.show = v;
      newRays?.setShow(v);
    },
    destroy: () => {
      viewer.dataSources.remove(ds, true);
      newRays?.destroy();
    },
  };
}

export default function RayTracingLayer({ show, pollMs = 6000, onSummary }: RayTracingLayerProps): null {
  const viewer = useCesiumViewer();
  const handlesRef = useRef<Partial<Record<RayLayerKey, LayerHandle>>>({});
  const showRef = useRef(show);

  // Build + keep the layers in sync with the published pipeline output.
  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    let currentSig: string | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const applyShow = () => {
      const s = showRef.current;
      const h = handlesRef.current;
      h.rays?.setShow(s.rays);
      h.coverage?.setShow(s.coverage);
      h.holes?.setShow(s.holes);
      h.proposals?.setShow(s.proposals);
      h.buildings?.setShow(s.buildings);
    };

    const destroyAll = () => {
      const h = handlesRef.current;
      (Object.keys(h) as RayLayerKey[]).forEach((k) => {
        h[k]?.destroy();
        delete h[k];
      });
    };

    const rebuild = async (sig: string) => {
      destroyAll();
      const bounds = await fetchJSON<CoverageBounds>(`${DATA}/coverage_bounds.json?t=${sig}`).catch(
        () => null
      );
      if (cancelled) return;

      // The whole OSM twin (buildings, rays, coverage, proposals) renders in the
      // single flat z = 0 frame the RT used, straight onto the globe ground — no
      // datum offset (GROUND_OFFSET === 0).

      // OSM building twin — the geometry the rays were traced against. Build first
      // so the rays visibly belong to it.
      try {
        const bfc = await fetchJSON<BuildingFeatureCollection>(`${DATA}/buildings.geojson?t=${sig}`);
        if (!cancelled) handlesRef.current.buildings = buildBuildings(bfc, GROUND_OFFSET, viewer.scene);
      } catch (error) {
        console.warn('RayTracingLayer: OSM buildings load failed', error);
      }
      if (cancelled) return;

      // Rays — the heavy one (paths.geojson can be tens of MB).
      try {
        const fc = await fetchJSON<LineFeatureCollection>(`${DATA}/paths.geojson?t=${sig}`);
        if (!cancelled) handlesRef.current.rays = buildLines(fc, RAY_COLOR, 0.28, GROUND_OFFSET, viewer.scene);
      } catch (error) {
        console.warn('RayTracingLayer: rays load failed', error);
      }
      if (cancelled) return;

      if (bounds) {
        try {
          const coverage = await buildCoverage(bounds, sig, viewer);
          if (cancelled) coverage.destroy();
          else handlesRef.current.coverage = coverage;
        } catch (error) {
          console.warn('RayTracingLayer: coverage load failed', error);
        }
      }
      if (cancelled) return;

      try {
        const holes = await buildHoles(sig, viewer);
        if (cancelled) holes.destroy();
        else handlesRef.current.holes = holes;
      } catch (error) {
        console.warn('RayTracingLayer: holes load failed', error);
      }
      if (cancelled) return;

      try {
        const proposals = await buildProposals(sig, GROUND_OFFSET, viewer);
        if (cancelled) proposals.destroy();
        else handlesRef.current.proposals = proposals;
      } catch (error) {
        console.warn('RayTracingLayer: proposals load failed', error);
      }

      if (cancelled) return;
      applyShow();
      viewer.scene.requestRender();
    };

    const poll = async () => {
      try {
        const summary = await fetchJSON<RtSummary>(`${DATA}/summary.json?t=${Date.now()}`);
        const sig = JSON.stringify(summary);
        if (sig !== currentSig) {
          currentSig = sig;
          onSummary?.(summary);
          // Fresh token forces the GeoJSON/PNG fetches past the browser cache so a
          // republished run is actually re-read, not served stale.
          await rebuild(String(Date.now()));
        }
      } catch {
        // pipeline hasn't published yet — keep polling
      }
    };

    poll();
    if (pollMs > 0) pollTimer = setInterval(poll, pollMs);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      destroyAll();
    };
  }, [viewer, pollMs, onSummary]);

  // Toggling visibility is cheap — flip primitive.show without rebuilding.
  useEffect(() => {
    showRef.current = show;
    const h = handlesRef.current;
    h.rays?.setShow(show.rays);
    h.coverage?.setShow(show.coverage);
    h.holes?.setShow(show.holes);
    h.proposals?.setShow(show.proposals);
    h.buildings?.setShow(show.buildings);
    viewer?.scene.requestRender();
  }, [show, viewer]);

  return null;
}

"use client";

/**
 * DeckScene — the live 3D coverage twin, ported from the standalone deck.gl
 * viewer (`viewer/app.js`, "trips" theme by Mehul Chourasia) into the HUD.
 *
 * Animated ray traces (TripsLayer) coloured by signal strength (orange = strong,
 * teal = weak) over height-shaded extruded OSM buildings, EE masts + cuOpt-proposed
 * masts, coverage holes and London place labels, on a tokenless CARTO Dark Matter
 * basemap (MapLibre + MapboxOverlay).
 *
 * It is a self-contained map *surface*: it reads the pipeline artifacts from
 * `/raytracing/*` and reads NO store (INVARIANTS §2 — surfaces take data, not the
 * store). Mounted as the centre-stage background in {@link AppShell}.
 */

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// Import from the @deck.gl/* subpaths (not the `deck.gl` umbrella) so this shares a
// single luma.gl instance with @deck.gl/mapbox — mixing the two double-loads luma.
import {
  AmbientLight,
  PointLight,
  DirectionalLight,
  LightingEffect,
} from "@deck.gl/core";
import { GeoJsonLayer, ColumnLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Color, Position, LayersList } from "@deck.gl/core";
import type { Feature, GeoJSON, MultiPolygon, Polygon } from "geojson";

// Where the pipeline artifacts are served from (nemoray/public/raytracing).
const DATA = "/raytracing";

// Tokenless CARTO "Dark Matter" basemap (ground, roads, water) — same family the
// deck.gl trips example uses.
const BASEMAP_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";

// ---- Theme (from the deck.gl "trips" example) -----------------------------
type RGB = [number, number, number];
const BUILDING_SHORT: RGB = [36, 42, 52];
const BUILDING_TALL: RGB = [150, 166, 192];
const BUILDING_HEIGHT_REF = 95; // metres at which the gradient saturates
const GROUND_COLOR = "#0c1119"; // subtle dark blue-grey ground tint
const TRAIL_STRONG: RGB = [253, 128, 93]; // orange → strong signal
const TRAIL_WEAK: RGB = [23, 184, 190]; // teal   → weak signal
const MAST_COLOR: RGB = [33, 212, 253];
const NEW_MAST_COLOR: RGB = [255, 210, 63];
const HOLE_COLOR: RGB = [255, 70, 70];
const MATERIAL = {
  ambient: 0.1,
  diffuse: 0.6,
  shininess: 32,
  specularColor: [60, 64, 70] as RGB,
};

// ---- Animation ------------------------------------------------------------
const LOOP_LENGTH = 1800;
const ANIMATION_SPEED = 1.2;
const TRAIL_LENGTH = 180;
const RAY_DURATION = 130;
const MAX_TRIPS = 140000; // cap rays for a clean, smooth field

// ---- Signal-strength model (pseudo-RSS from path length + bounces) --------
const REF_DBM = 58; // reference mast EIRP
const RSS_MIN = -115,
  RSS_MAX = -45;
const BOUNCE_LOSS = 6; // dB lost per reflection/diffraction

// Key London landmarks within the simulated square, as orientation pointers.
interface Landmark {
  name: string;
  lng: number;
  lat: number;
}
const LANDMARKS: Landmark[] = [
  { name: "City of London", lng: -0.091, lat: 51.515 },
  { name: "Canary Wharf", lng: -0.0195, lat: 51.505 },
  { name: "The Shard", lng: -0.0865, lat: 51.5045 },
  { name: "Tower Bridge", lng: -0.0754, lat: 51.5055 },
  { name: "Shoreditch", lng: -0.078, lat: 51.5265 },
  { name: "Liverpool St", lng: -0.0817, lat: 51.518 },
  { name: "Greenwich", lng: -0.009, lat: 51.481 },
];

interface Bounds {
  west: number;
  east: number;
  south: number;
  north: number;
}
interface BuildingProps {
  height?: number;
}
interface RayFeature {
  geometry: { coordinates: number[][] };
  properties: { bounces?: number };
}
interface MastFeature {
  geometry: { coordinates: number[] };
  properties: { height_m?: number };
}
interface FC<F> {
  features: F[];
}
type HoleFC = FC<Feature<Polygon | MultiPolygon>>;

interface Trip {
  path: Position[];
  timestamps: number[];
  color: RGB;
}
interface Mast {
  pos: Position;
  h: number;
}
interface Hole {
  pos: Position;
}
interface SceneData {
  buildings: GeoJSON;
  trips: Trip[];
  masts: Mast[];
  newMasts: Mast[];
  holes: Hole[];
}

// ---- helpers --------------------------------------------------------------
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (c0: RGB, c1: RGB, t: number): RGB => [
  Math.round(c0[0] + (c1[0] - c0[0]) * t),
  Math.round(c0[1] + (c1[1] - c0[1]) * t),
  Math.round(c0[2] + (c1[2] - c0[2]) * t),
];
function dist3(a: number[], b: number[]) {
  const lat = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (b[0] - a[0]) * 111320 * Math.cos(lat);
  const dy = (b[1] - a[1]) * 110540;
  const dz = (b[2] || 0) - (a[2] || 0);
  return Math.hypot(dx, dy, dz);
}
async function fetchJSON(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// Each ray becomes a deck.gl "trip": a path, per-vertex timestamps (a pulse that
// travels from the mast outward, staggered by a random phase), and a strength colour.
function toTrips(fc: FC<RayFeature>): Trip[] {
  const feats = fc.features;
  const step = Math.max(1, Math.ceil(feats.length / MAX_TRIPS));
  const trips: Trip[] = [];
  for (let k = 0; k < feats.length; k += step) {
    const coords = feats[k].geometry.coordinates;
    if (coords.length < 2) continue;
    const cum = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += dist3(coords[i - 1], coords[i]);
      cum.push(total);
    }
    if (total <= 0) continue;
    const phase = Math.random() * LOOP_LENGTH;
    const timestamps = cum.map((c) => phase + (c / total) * RAY_DURATION);
    const bounces = feats[k].properties.bounces ?? coords.length - 2;
    const rss =
      REF_DBM - (20 * Math.log10(Math.max(total, 1)) + 37.55) - bounces * BOUNCE_LOSS;
    const t = clamp01((rss - RSS_MIN) / (RSS_MAX - RSS_MIN));
    const color = mix(TRAIL_WEAK, TRAIL_STRONG, t);
    const path = coords as unknown as Position[];
    trips.push({ path, timestamps, color });
    // Seamless loop: a ray whose pulse straddles the loop boundary is duplicated one
    // loop earlier, so it flows continuously across the wrap (no visible reset).
    if (phase + RAY_DURATION + TRAIL_LENGTH > LOOP_LENGTH)
      trips.push({ path, timestamps: timestamps.map((ts) => ts - LOOP_LENGTH), color });
  }
  return trips;
}

// Only masts within the simulated area of interest (drop the rest of Greater London).
function toMasts(fc: FC<MastFeature> | null, bounds: Bounds | null): Mast[] {
  if (!fc) return [];
  const out: Mast[] = [];
  for (const f of fc.features) {
    const [lng, lat] = f.geometry.coordinates;
    if (
      bounds &&
      (lng < bounds.west || lng > bounds.east || lat < bounds.south || lat > bounds.north)
    )
      continue;
    out.push({ pos: [lng, lat], h: Math.max(f.properties.height_m || 15, 10) });
  }
  return out;
}

function toHoles(fc: HoleFC | null): Hole[] {
  if (!fc) return [];
  return fc.features.map((f) => {
    const g = f.geometry;
    const ring =
      g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0];
    let x = 0,
      y = 0;
    for (const c of ring) {
      x += c[0];
      y += c[1];
    }
    return { pos: [x / ring.length, y / ring.length] };
  });
}

function buildLayers(data: SceneData, time: number): LayersList {
  const L: LayersList = [];

  if (data.buildings)
    L.push(
      new GeoJsonLayer<BuildingProps>({
        id: "buildings",
        data: data.buildings,
        extruded: true,
        wireframe: false,
        opacity: 0.92,
        material: MATERIAL,
        getElevation: (f) => f.properties.height || 9,
        getFillColor: (f) =>
          mix(
            BUILDING_SHORT,
            BUILDING_TALL,
            clamp01((f.properties.height || 9) / BUILDING_HEIGHT_REF),
          ),
        pickable: false,
      }),
    );

  if (data.holes.length)
    L.push(
      new ScatterplotLayer<Hole>({
        id: "holes",
        data: data.holes,
        radiusUnits: "meters",
        radiusMinPixels: 2,
        getPosition: (d) => d.pos,
        getRadius: 30,
        getFillColor: [...HOLE_COLOR, 150] as Color,
        stroked: false,
      }),
    );

  if (data.masts.length)
    L.push(
      new ColumnLayer<Mast>({
        id: "masts",
        data: data.masts,
        diskResolution: 6,
        radius: 9,
        extruded: true,
        getPosition: (d) => d.pos,
        getElevation: (d) => d.h,
        getFillColor: [...MAST_COLOR, 210] as Color,
        material: MATERIAL,
      }),
    );

  if (data.newMasts.length)
    L.push(
      new ColumnLayer<Mast>({
        id: "newmasts",
        data: data.newMasts,
        diskResolution: 8,
        radius: 18,
        extruded: true,
        getPosition: (d) => d.pos,
        getElevation: (d) => d.h + 6,
        getFillColor: [...NEW_MAST_COLOR, 235] as Color,
        material: MATERIAL,
      }),
    );

  if (data.trips.length)
    L.push(
      new TripsLayer<Trip>({
        id: "rays",
        data: data.trips,
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: (d) => d.color,
        opacity: 0.8,
        widthUnits: "pixels",
        getWidth: 2.4,
        widthMinPixels: 2,
        capRounded: true,
        jointRounded: true,
        trailLength: TRAIL_LENGTH,
        currentTime: time,
        fadeTrail: true,
      }),
    );

  // Place labels last so they sit on top — orientation pointers in the UI theme.
  L.push(
    new ScatterplotLayer<Landmark>({
      id: "label-dots",
      data: LANDMARKS,
      getPosition: (d) => [d.lng, d.lat],
      radiusUnits: "meters",
      getRadius: 40,
      radiusMinPixels: 3,
      radiusMaxPixels: 6,
      getFillColor: [33, 212, 253, 230],
      stroked: true,
      lineWidthMinPixels: 1.2,
      getLineColor: [8, 12, 18, 255],
    }),
  );
  L.push(
    new TextLayer<Landmark>({
      id: "labels",
      data: LANDMARKS,
      getPosition: (d) => [d.lng, d.lat],
      getText: (d) => d.name,
      getSize: 12.5,
      sizeUnits: "pixels",
      getColor: [226, 232, 242, 240],
      billboard: true,
      getPixelOffset: [0, -12],
      getTextAnchor: "middle",
      getAlignmentBaseline: "bottom",
      fontFamily: "system-ui, sans-serif",
      fontWeight: 600,
      characterSet: "auto",
      background: true,
      getBackgroundColor: [10, 15, 23, 195],
      backgroundPadding: [6, 3, 6, 3],
    }),
  );

  return L;
}

export function DeckScene() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let map: maplibregl.Map | null = null;
    let overlay: MapboxOverlay | null = null;
    let raf = 0;
    let cancelled = false;

    (async () => {
      const bounds = (await fetchJSON(`${DATA}/coverage_bounds.json`)) as Bounds;
      if (cancelled) return;
      const cLng = (bounds.west + bounds.east) / 2;
      const cLat = (bounds.south + bounds.north) / 2;

      map = new maplibregl.Map({
        container,
        style: BASEMAP_STYLE,
        canvasContextAttributes: { antialias: true },
        maxPitch: 75,
        center: [cLng, cLat - 0.008],
        zoom: 12.6,
        pitch: 50,
        bearing: 0,
        attributionControl: false,
      });

      map.on("load", () => {
        if (!map) return;
        for (const l of map.getStyle().layers) {
          // Drop the basemap's own building footprints — our extruded buildings replace them.
          if (/building/i.test(l.id)) map.removeLayer(l.id);
          // Nudge the ground tint ever so slightly.
          else if (l.type === "background")
            map.setPaintProperty(l.id, "background-color", GROUND_COLOR);
        }
      });

      // Low ambient + a strong, low-angled "sun" so each building has a bright face and a
      // deep shadowed face (depth cue); a soft cool fill keeps shadow sides from pure black.
      const lighting = new LightingEffect({
        ambient: new AmbientLight({ color: [255, 255, 255], intensity: 0.28 }),
        sun: new DirectionalLight({
          color: [255, 245, 228],
          intensity: 2.3,
          direction: [-1.3, -0.45, -0.9],
        }),
        fill: new PointLight({
          color: [150, 185, 235],
          intensity: 0.6,
          position: [cLng, cLat, 6000],
        }),
      });
      overlay = new MapboxOverlay({ interleaved: false, effects: [lighting], layers: [] });
      map.addControl(overlay);

      // Load everything in parallel.
      const [buildings, raysFC, mastsFC, newFC, holesFC] = await Promise.all([
        fetchJSON(`${DATA}/buildings.geojson`) as Promise<GeoJSON>,
        fetchJSON(`${DATA}/paths.geojson`) as Promise<FC<RayFeature>>,
        fetchJSON(`${DATA}/masts.geojson`).catch(() => null) as Promise<FC<MastFeature> | null>,
        fetchJSON(`${DATA}/new_masts.geojson`).catch(() => null) as Promise<FC<MastFeature> | null>,
        fetchJSON(`${DATA}/hotspots.geojson`).catch(() => null) as Promise<HoleFC | null>,
      ]);
      if (cancelled) return;

      const data: SceneData = {
        buildings,
        trips: toTrips(raysFC),
        masts: toMasts(mastsFC, bounds),
        newMasts: toMasts(newFC, bounds),
        holes: toHoles(holesFC),
      };

      let time = 0;
      const animate = () => {
        if (cancelled || !overlay) return;
        time = (time + ANIMATION_SPEED) % LOOP_LENGTH;
        overlay.setProps({ layers: buildLayers(data, time) });
        raf = requestAnimationFrame(animate);
      };
      animate();
    })().catch((e) => console.error("[DeckScene]", e));

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (overlay) overlay.finalize();
      if (map) map.remove();
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0 h-full w-full" />;
}

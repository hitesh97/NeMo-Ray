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
 * Masts are drawn as the project's own glTF antenna/tower models (`/models/*`,
 * `ScenegraphLayer`) scaled to each site's height with a beacon dot on top, and the
 * emergency-services feed (police / fire / hospital) is drawn as colour-coded 3D
 * columns capped with the map-pin icons from `/icons/*.svg` and a base dot — the same
 * visual language the retired Cesium scene used, rebuilt on deck.gl.
 *
 * It is a self-contained map *surface*: it reads the pipeline artifacts from
 * `/raytracing/*` (+ the `/api/emergency-services` feed) and reads NO store
 * (INVARIANTS §2 — surfaces take data, not the store). Mounted as the centre-stage
 * background in {@link AppShell}.
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
import { GeoJsonLayer, ScatterplotLayer, IconLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { ScenegraphLayer } from "@deck.gl/mesh-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Color, Position, Layer, LayersList } from "@deck.gl/core";
import type { Feature, GeoJSON, MultiPolygon, Polygon } from "geojson";

// Where the pipeline artifacts are served from (nemoray/public/raytracing).
const DATA = "/raytracing";
// Where the restored glTF antenna/tower models live (nemoray/public/models).
const MODELS = "/models";

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
const MAST_COLOR: RGB = [33, 212, 253]; // cyan  → existing EE masts
const NEW_MAST_COLOR: RGB = [255, 210, 63]; // gold → cuOpt-proposed masts
const HOLE_COLOR: RGB = [255, 70, 70];
const MATERIAL = {
  ambient: 0.1,
  diffuse: 0.6,
  shininess: 32,
  specularColor: [60, 64, 70] as RGB,
};

// ---- Antenna / tower glTF models ------------------------------------------
// Native world-space Y extents per model (yRange = full height in native units,
// yMin = lowest vertex). These reproduce the scale/ground-offset maths from the
// retired Cesium `SitefinderTowerLayer`: a model is scaled by `targetHeight / yRange`
// and lifted by `-yMin * scale` so its base sits exactly on the ground. The big
// 102 MB `cell_tower` model is intentionally not restored — tall sites fall back to
// the slim `radio_tower` instead.
type ModelKey = "radio" | "antennaA" | "antennaB" | "antennaC";
interface ModelSpec {
  uri: string;
  yRange: number;
  yMin: number;
}
const ANTENNA_MODELS: Record<ModelKey, ModelSpec> = {
  radio: { uri: `${MODELS}/radio_tower/scene.gltf`, yRange: 12730, yMin: -5089 },
  antennaA: { uri: `${MODELS}/antenna_a/scene.gltf`, yRange: 7.09, yMin: -3.545 },
  antennaB: { uri: `${MODELS}/antenna_b/scene.gltf`, yRange: 4.744, yMin: -3.258 },
  antennaC: { uri: `${MODELS}/antenna_c/scene.gltf`, yRange: 8.429, yMin: -3.545 },
};
const ROOFTOP_MODELS: ModelKey[] = ["antennaA", "antennaB", "antennaC"];
// At/above this height a site reads as a free-standing tower (radio_tower); below it
// reads as a rooftop antenna mast (the small antenna_* models).
const TOWER_HEIGHT_M = 24;

// ---- Emergency-services markers -------------------------------------------
type ServiceType = "police" | "fire" | "hospital";
const SERVICE_COLOR: Record<ServiceType, RGB> = {
  police: [43, 111, 255], // blue   (#2b6fff)
  fire: [255, 59, 48], // red    (#ff3b30)
  hospital: [255, 77, 157], // pink   (#ff4d9d)
};
const SERVICE_ICON: Record<
  ServiceType,
  { url: string; width: number; height: number; anchorY: number; mask: boolean }
> = {
  police: { url: "/icons/police.svg", width: 96, height: 128, anchorY: 128, mask: false },
  fire: { url: "/icons/fire.svg", width: 96, height: 128, anchorY: 128, mask: false },
  hospital: { url: "/icons/hospital.svg", width: 96, height: 128, anchorY: 128, mask: false },
};
const SERVICE_LABEL: Record<ServiceType, string> = {
  police: "Police",
  fire: "Fire",
  hospital: "Hospital",
};
// A service point is bound to the OSM footprint it sits inside, or — failing that —
// the nearest footprint whose centroid is within this radius. Points with no footprint
// in range are dropped (the feed's coordinates are address centroids, not building
// outlines, so a hard miss usually means the building was simplified out of the set).
const SERVICE_SNAP_M = 50;

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
  // Tagged in place when a service point is matched to this footprint, so the
  // buildings layer can paint it in the service colour.
  service?: ServiceType;
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

interface EmergencyService {
  id: string;
  type: ServiceType;
  name: string;
  lat: number;
  lng: number;
}
interface EmergencyPayload {
  services: EmergencyService[];
}

interface Trip {
  path: Position[];
  timestamps: number[];
  color: RGB;
}
// A sited antenna: ground position, the chosen glTF model and the metres-tall it
// should render at (`vh`).
interface Mast {
  pos: Position;
  model: ModelKey;
  vh: number;
}
// A matched service: a pin floating over the coloured footprint. `pos` is the
// footprint centroid, `h` the building height (so the pin sits just above the roof),
// `name` the station / hospital name shown on click.
interface Marker {
  pos: Position;
  type: ServiceType;
  h: number;
  name: string;
}
interface Hole {
  pos: Position;
}
interface SceneData {
  buildings: GeoJSON;
  trips: Trip[];
  masts: Mast[];
  newMasts: Mast[];
  markers: Marker[];
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
const inBounds = (lng: number, lat: number, b: Bounds | null) =>
  !b || (lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north);
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

// Choose a glTF model + render-height for a site. Tall sites get the free-standing
// radio tower; shorter ones get one of the rooftop antenna variants (picked
// deterministically by index so the field looks varied but stable across frames).
// Proposed masts are forced to the prominent tower.
function pickModel(idx: number, h: number, forceTower: boolean): { model: ModelKey; vh: number } {
  if (forceTower || h >= TOWER_HEIGHT_M)
    return { model: "radio", vh: Math.max(h, forceTower ? 28 : TOWER_HEIGHT_M) };
  return {
    model: ROOFTOP_MODELS[idx % ROOFTOP_MODELS.length],
    vh: Math.max(6, Math.min(h, 12)),
  };
}

// Only masts within the simulated area of interest (drop the rest of Greater London),
// each resolved to a glTF model + render-height.
function toMasts(
  fc: FC<MastFeature> | null,
  bounds: Bounds | null,
  forceTower: boolean,
): Mast[] {
  if (!fc) return [];
  const out: Mast[] = [];
  let idx = 0;
  for (const f of fc.features) {
    const [lng, lat] = f.geometry.coordinates;
    if (!inBounds(lng, lat, bounds)) continue;
    const h = Math.max(f.properties.height_m || 15, 10);
    const { model, vh } = pickModel(idx++, h, forceTower);
    out.push({ pos: [lng, lat], model, vh });
  }
  return out;
}

const metresBetween = (aLng: number, aLat: number, bLng: number, bLat: number) => {
  const lat = (((aLat + bLat) / 2) * Math.PI) / 180;
  return Math.hypot((bLng - aLng) * 111320 * Math.cos(lat), (bLat - aLat) * 110540);
};
function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1],
      xj = ring[j][0],
      yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// One indexed building footprint: outer ring, bbox (fast reject) and centroid.
interface BuildingCell {
  feature: Feature<Polygon | MultiPolygon, BuildingProps>;
  ring: number[][];
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  cLng: number;
  cLat: number;
}
function indexBuildings(buildings: GeoJSON): BuildingCell[] {
  const cells: BuildingCell[] = [];
  if (buildings.type !== "FeatureCollection") return cells;
  for (const feature of buildings.features) {
    const g = feature.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
    if (!ring || ring.length < 3) continue;
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity,
      sx = 0,
      sy = 0;
    for (const [x, y] of ring) {
      if (x < minLng) minLng = x;
      if (y < minLat) minLat = y;
      if (x > maxLng) maxLng = x;
      if (y > maxLat) maxLat = y;
      sx += x;
      sy += y;
    }
    cells.push({
      feature: feature as Feature<Polygon | MultiPolygon, BuildingProps>,
      ring,
      minLng,
      minLat,
      maxLng,
      maxLat,
      cLng: sx / ring.length,
      cLat: sy / ring.length,
    });
  }
  return cells;
}

// Bind each in-bounds service to a building footprint: the one it sits inside, else
// the nearest footprint whose centroid is within SERVICE_SNAP_M. Tags the matched
// feature in place (so the buildings layer paints it) and returns a pin per match.
// First match wins a footprint; unmatched services are dropped.
function matchServiceBuildings(
  buildings: GeoJSON,
  payload: EmergencyPayload | null,
  bounds: Bounds | null,
): Marker[] {
  if (!payload) return [];
  const cells = indexBuildings(buildings);
  const markers: Marker[] = [];
  for (const s of payload.services) {
    if (!inBounds(s.lng, s.lat, bounds)) continue;
    let hit: BuildingCell | null = null;
    let best = SERVICE_SNAP_M;
    for (const c of cells) {
      if (c.feature.properties.service) continue; // already claimed
      if (s.lng >= c.minLng && s.lng <= c.maxLng && s.lat >= c.minLat && s.lat <= c.maxLat) {
        if (pointInRing(s.lng, s.lat, c.ring)) {
          hit = c;
          break;
        }
      }
      const d = metresBetween(s.lng, s.lat, c.cLng, c.cLat);
      if (d < best) {
        best = d;
        hit = c;
      }
    }
    if (!hit) continue;
    hit.feature.properties.service = s.type;
    markers.push({
      pos: [hit.cLng, hit.cLat],
      type: s.type,
      h: hit.feature.properties.height ?? 12,
      name: s.name,
    });
  }
  return markers;
}

function toHoles(fc: HoleFC | null): Hole[] {
  if (!fc) return [];
  return fc.features.map((f) => {
    const g = f.geometry;
    const ring = g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0];
    let x = 0,
      y = 0;
    for (const c of ring) {
      x += c[0];
      y += c[1];
    }
    return { pos: [x / ring.length, y / ring.length] };
  });
}

// One ScenegraphLayer per model variant present in `masts` (a layer renders a single
// glTF, instanced across its data). Each instance is scaled to its site height and
// lifted so the model's base sits on the ground.
function antennaLayers(idPrefix: string, masts: Mast[]): Layer[] {
  const byModel = new Map<ModelKey, Mast[]>();
  for (const m of masts) {
    const group = byModel.get(m.model);
    if (group) group.push(m);
    else byModel.set(m.model, [m]);
  }
  const layers: Layer[] = [];
  for (const [key, group] of byModel) {
    const spec = ANTENNA_MODELS[key];
    layers.push(
      new ScenegraphLayer<Mast>({
        id: `${idPrefix}-${key}`,
        data: group,
        scenegraph: spec.uri,
        _lighting: "pbr",
        sizeScale: 1,
        getPosition: (d) => d.pos,
        getOrientation: [0, 0, 0],
        getScale: (d) => {
          const s = d.vh / spec.yRange;
          return [s, s, s];
        },
        getTranslation: (d) => [0, 0, -spec.yMin * (d.vh / spec.yRange)],
        pickable: false,
      }),
    );
  }
  return layers;
}

// A billboarded beacon dot floating at the top of each antenna — keeps sites locatable
// from a top-down camera and over distance, the way the old scene's always-on dots did.
function antennaDots(id: string, masts: Mast[], color: RGB): ScatterplotLayer<Mast> {
  return new ScatterplotLayer<Mast>({
    id,
    data: masts,
    billboard: true,
    radiusUnits: "pixels",
    getPosition: (d) => [d.pos[0], d.pos[1], d.vh + 4],
    getRadius: 4.5,
    radiusMinPixels: 3,
    radiusMaxPixels: 7,
    getFillColor: [...color, 235] as Color,
    stroked: true,
    lineWidthMinPixels: 1.2,
    getLineColor: [8, 12, 18, 255],
  });
}

// The static (non-animated) layers — buildings, antennas, emergency services, holes
// and labels. Built once and reused across animation frames so the glTF models aren't
// reloaded and instance attributes aren't recomputed every tick.
function buildStaticLayers(data: SceneData, onPick: (m: Marker | null) => void): LayersList {
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
        // A footprint matched to an emergency service is wrapped wholesale in that
        // service's colour; everything else keeps the short→tall height ramp.
        getFillColor: (f) =>
          f.properties.service
            ? ([...SERVICE_COLOR[f.properties.service], 255] as Color)
            : mix(
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

  // Emergency services: a clickable map-pin floating just above each colour-wrapped
  // footprint. Clicking a pin surfaces the station / hospital name (see the label layer).
  if (data.markers.length)
    L.push(
      new IconLayer<Marker>({
        id: "service-icons",
        data: data.markers,
        billboard: true,
        sizeUnits: "pixels",
        getIcon: (d) => SERVICE_ICON[d.type],
        getPosition: (d) => [d.pos[0], d.pos[1], d.h + 6],
        getSize: 34,
        sizeMinPixels: 20,
        sizeMaxPixels: 46,
        pickable: true,
        onClick: (info) => {
          onPick((info.object as Marker) ?? null);
          return true;
        },
      }),
    );

  // Antennas: existing EE masts (cyan beacon) + cuOpt-proposed masts (gold beacon),
  // each as the project's glTF tower/antenna models scaled to the site height.
  L.push(...antennaLayers("masts", data.masts));
  if (data.masts.length) L.push(antennaDots("mast-dots", data.masts, MAST_COLOR));
  L.push(...antennaLayers("newmasts", data.newMasts));
  if (data.newMasts.length) L.push(antennaDots("newmast-dots", data.newMasts, NEW_MAST_COLOR));

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

// A name label for the currently-selected service pin (empty when nothing is picked).
// Rendered per-frame so it can follow click selection without rebuilding the scene.
function buildSelectionLabel(selected: Marker | null): TextLayer<Marker> {
  return new TextLayer<Marker>({
    id: "service-label",
    data: selected ? [selected] : [],
    getPosition: (d) => [d.pos[0], d.pos[1], d.h + 6],
    getText: (d) => `${SERVICE_LABEL[d.type]} · ${d.name}`,
    getSize: 13,
    sizeUnits: "pixels",
    getColor: [236, 240, 248, 255],
    billboard: true,
    getPixelOffset: [0, -46],
    getTextAnchor: "middle",
    getAlignmentBaseline: "bottom",
    fontFamily: "system-ui, sans-serif",
    fontWeight: 600,
    characterSet: "auto",
    background: true,
    getBackgroundColor: [10, 15, 23, 230],
    backgroundPadding: [8, 4, 8, 4],
  });
}

// The single animated layer — the signal-ray trips, advanced each frame by `time`.
function buildRaysLayer(trips: Trip[], time: number): TripsLayer<Trip> {
  return new TripsLayer<Trip>({
    id: "rays",
    data: trips,
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
  });
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
      const [buildings, raysFC, mastsFC, newFC, holesFC, emergency] = await Promise.all([
        fetchJSON(`${DATA}/buildings.geojson`) as Promise<GeoJSON>,
        fetchJSON(`${DATA}/paths.geojson`) as Promise<FC<RayFeature>>,
        fetchJSON(`${DATA}/masts.geojson`).catch(() => null) as Promise<FC<MastFeature> | null>,
        fetchJSON(`${DATA}/new_masts.geojson`).catch(() => null) as Promise<FC<MastFeature> | null>,
        fetchJSON(`${DATA}/hotspots.geojson`).catch(() => null) as Promise<HoleFC | null>,
        fetchJSON(`/api/emergency-services`).catch(() => null) as Promise<EmergencyPayload | null>,
      ]);
      if (cancelled) return;

      const data: SceneData = {
        buildings,
        trips: toTrips(raysFC),
        masts: toMasts(mastsFC, bounds, false),
        newMasts: toMasts(newFC, bounds, true),
        // Tags matched footprints in `buildings` in place, so build this before the layers.
        markers: matchServiceBuildings(buildings, emergency, bounds),
        holes: toHoles(holesFC),
      };

      // Currently-selected service pin (click a pin to show its name, click empty to clear).
      let selected: Marker | null = null;
      // Build the static layers once; only the rays + selection label are rebuilt per frame.
      const staticLayers = buildStaticLayers(data, (m) => {
        selected = m;
      });
      // Clear the selection when the click misses every pickable layer.
      overlay.setProps({
        onClick: (info) => {
          if (!info.picked) selected = null;
        },
      });

      let time = 0;
      const animate = () => {
        if (cancelled || !overlay) return;
        time = (time + ANIMATION_SPEED) % LOOP_LENGTH;
        overlay.setProps({
          layers: [...staticLayers, buildRaysLayer(data.trips, time), buildSelectionLabel(selected)],
        });
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

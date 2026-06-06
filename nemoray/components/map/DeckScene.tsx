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
 * Masts are drawn as procedural white/red comms-mast columns scaled to each site's
 * height with a beacon dot on top (blue = existing EE, gold = cuOpt-proposed). The
 * emergency-services feed (police / fire / hospital) is point-matched to the OSM
 * footprint each station sits in, that whole footprint is painted in the service colour,
 * and a map-pin from `/icons/*.svg` floats above it with the name revealed on zoom-in.
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
import {
  GeoJsonLayer,
  ColumnLayer,
  ScatterplotLayer,
  IconLayer,
  TextLayer,
} from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Color, Position, Layer, LayersList } from "@deck.gl/core";
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
const HOLE_COLOR: RGB = [255, 70, 70];
const MATERIAL = {
  ambient: 0.1,
  diffuse: 0.6,
  shininess: 32,
  specularColor: [60, 64, 70] as RGB,
};

// ---- Antenna / mast styling -----------------------------------------------
// Masts render as a bold procedural "comms mast": a white tower with a red top band
// (the aviation red/white marking) and a coloured beacon dot on top — blue for existing
// EE masts, gold for cuOpt-proposed ones. (glTF tower meshes were tried but deck.gl's
// loader rendered them unreliably; flat columns are guaranteed visible and read cleanly.)
const MAST_WHITE: RGB = [232, 236, 244];
const MAST_RED: RGB = [226, 58, 53];
const MAST_DOT_EE: RGB = [40, 130, 255]; // blue beacon → existing EE masts
const MAST_DOT_NEW: RGB = [255, 200, 60]; // gold beacon → cuOpt-proposed masts
const MAST_RADIUS_M = 3; // tower half-width
// Minimum render height so a short rooftop mast still reads as a tower, not a speck.
const MIN_TOWER_M = 14;

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
// A sited antenna: ground position and the metres-tall it should render at (`vh`).
interface Mast {
  pos: Position;
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

// Only masts within the simulated area of interest (drop the rest of Greater London),
// each rendered as the radio tower sized to its height. Proposed (cuOpt) masts are made
// a touch taller so they stand out from the existing field.
function toMasts(
  fc: FC<MastFeature> | null,
  bounds: Bounds | null,
  proposed: boolean,
): Mast[] {
  if (!fc) return [];
  const out: Mast[] = [];
  for (const f of fc.features) {
    const [lng, lat] = f.geometry.coordinates;
    if (!inBounds(lng, lat, bounds)) continue;
    const h = Math.max(f.properties.height_m || 15, 10);
    const vh = proposed ? Math.max(h + 4, 28) : Math.max(h, MIN_TOWER_M);
    out.push({ pos: [lng, lat], vh });
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

// One indexed building footprint: outer ring, bbox (fast reject), centroid and a
// rough planar area (used to anchor the pin over the dominant mass of a complex).
interface BuildingCell {
  feature: Feature<Polygon | MultiPolygon, BuildingProps>;
  ring: number[][];
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  cLng: number;
  cLat: number;
  area: number;
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
      sy = 0,
      shoelace = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i];
      if (x < minLng) minLng = x;
      if (y < minLat) minLat = y;
      if (x > maxLng) maxLng = x;
      if (y > maxLat) maxLat = y;
      sx += x;
      sy += y;
      const [nx, ny] = ring[(i + 1) % ring.length];
      shoelace += x * ny - nx * y;
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
      area: Math.abs(shoelace) / 2,
    });
  }
  return cells;
}

// Bind each in-bounds service to its building. A campus/complex is modelled as several
// stacked or tiled footprints (e.g. Guy's Hospital = a slim tower over a wide podium),
// so we paint *every* footprint that contains the point — not just the first — and only
// fall back to the nearest footprint (within SERVICE_SNAP_M) when none contains it. The
// pin sits over the largest matched mass. A footprint already claimed by another service
// is left alone; services with no footprint in range are dropped.
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
    const seeds: BuildingCell[] = [];
    let nearest: BuildingCell | null = null;
    let best = SERVICE_SNAP_M;
    for (const c of cells) {
      if (c.feature.properties.service) continue; // already claimed by another service
      if (
        s.lng >= c.minLng &&
        s.lng <= c.maxLng &&
        s.lat >= c.minLat &&
        s.lat <= c.maxLat &&
        pointInRing(s.lng, s.lat, c.ring)
      ) {
        seeds.push(c);
        continue;
      }
      const d = metresBetween(s.lng, s.lat, c.cLng, c.cLat);
      if (d < best) {
        best = d;
        nearest = c;
      }
    }
    if (seeds.length === 0 && nearest) seeds.push(nearest);
    if (seeds.length === 0) continue;
    let anchor = seeds[0];
    for (const c of seeds) {
      c.feature.properties.service = s.type;
      if (c.area > anchor.area) anchor = c;
    }
    markers.push({
      pos: [anchor.cLng, anchor.cLat],
      type: s.type,
      h: anchor.feature.properties.height ?? 12,
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

// A procedural comms mast per site: a white tower (lower 80%), a red top band (upper
// 20%, sitting on top of the white via its z-base) and a billboarded beacon dot above
// it. The dot stays visible as a pixel-sized point from any distance, so the antenna
// field reads as a clear "where are the masts" map even when zoomed out.
function antennaLayers(idPrefix: string, masts: Mast[], dot: RGB): Layer[] {
  if (!masts.length) return [];
  return [
    new ColumnLayer<Mast>({
      id: `${idPrefix}-body`,
      data: masts,
      diskResolution: 4,
      radius: MAST_RADIUS_M,
      angle: 45,
      extruded: true,
      getPosition: (d) => d.pos,
      getElevation: (d) => d.vh * 0.8,
      getFillColor: [...MAST_WHITE, 255] as Color,
      material: MATERIAL,
      pickable: false,
    }),
    new ColumnLayer<Mast>({
      id: `${idPrefix}-cap`,
      data: masts,
      diskResolution: 4,
      radius: MAST_RADIUS_M,
      angle: 45,
      extruded: true,
      // Stack the red cap on top of the white body (column base = the position's z).
      getPosition: (d) => [d.pos[0], d.pos[1], d.vh * 0.8],
      getElevation: (d) => d.vh * 0.2,
      getFillColor: [...MAST_RED, 255] as Color,
      material: MATERIAL,
      pickable: false,
    }),
    new ScatterplotLayer<Mast>({
      id: `${idPrefix}-dot`,
      data: masts,
      billboard: true,
      radiusUnits: "pixels",
      getPosition: (d) => [d.pos[0], d.pos[1], d.vh + 5],
      getRadius: 5,
      radiusMinPixels: 3,
      radiusMaxPixels: 8,
      getFillColor: [...dot, 255] as Color,
      stroked: true,
      lineWidthMinPixels: 1.4,
      getLineColor: [8, 12, 18, 255],
    }),
  ];
}

// The static (non-animated) layers — buildings, antennas, emergency services, holes
// and labels. Built once and reused across animation frames so the glTF models aren't
// reloaded and instance attributes aren't recomputed every tick.
function buildStaticLayers(data: SceneData): LayersList {
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

  // Emergency services: a map-pin floating just above each colour-wrapped footprint.
  // The station / hospital name appears automatically when the camera is close (see
  // the proximity label layer, rebuilt per-frame against the live zoom).
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
        pickable: false,
      }),
    );

  // Antennas: white/red comms masts sized to site height — existing EE masts get a blue
  // beacon dot, cuOpt-proposed masts a gold one.
  L.push(...antennaLayers("masts", data.masts, MAST_DOT_EE));
  L.push(...antennaLayers("newmasts", data.newMasts, MAST_DOT_NEW));

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

// Service names reveal automatically once the camera is zoomed in past this level —
// "in proximity" — and hide again on zoom-out so the wide view stays uncluttered.
const SERVICE_LABEL_ZOOM = 14;

// Name labels for every service pin, shown only when `visible` (the live zoom is past
// SERVICE_LABEL_ZOOM). Rebuilt per-frame so it tracks zoom without rebuilding the scene.
function buildServiceLabels(markers: Marker[], visible: boolean): TextLayer<Marker> {
  return new TextLayer<Marker>({
    id: "service-labels",
    data: visible ? markers : [],
    getPosition: (d) => [d.pos[0], d.pos[1], d.h + 6],
    getText: (d) => `${SERVICE_LABEL[d.type]} · ${d.name}`,
    getSize: 12.5,
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

      // Build the static layers once; only the rays + proximity labels are rebuilt per frame.
      const staticLayers = buildStaticLayers(data);

      let time = 0;
      const animate = () => {
        if (cancelled || !overlay) return;
        time = (time + ANIMATION_SPEED) % LOOP_LENGTH;
        const nearEnough = (map?.getZoom() ?? 0) >= SERVICE_LABEL_ZOOM;
        overlay.setProps({
          layers: [
            ...staticLayers,
            buildRaysLayer(data.trips, time),
            buildServiceLabels(data.markers, nearEnough),
          ],
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

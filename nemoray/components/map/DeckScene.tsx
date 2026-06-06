"use client";

/**
 * DeckScene — the live 3D coverage twin, ported from the standalone deck.gl
 * viewer (`viewer/app.js`, "trips" theme by Mehul Chourasia) into the HUD.
 *
 * Animated ray traces (TripsLayer) coloured by antenna load share (green = light,
 * red = stressed) over height-shaded extruded OSM buildings, EE masts + cuOpt-proposed
 * masts, coverage holes and London place labels, on a tokenless CARTO Dark Matter
 * basemap (MapLibre + MapboxOverlay).
 *
 * Masts are drawn as procedural red/white 3D lattice towers (PathLayer polylines:
 * four tapered legs, rung rings, X-bracing and a spire) scaled to each site's height
 * with a beacon dot on top (blue = existing EE, gold = cuOpt-proposed). The
 * emergency-services feed (police / fire / hospital) is point-matched to the OSM
 * footprint each station sits in, that whole footprint is painted in the service colour,
 * and a map-pin from `/icons/*.svg` floats above it with the name revealed on zoom-in.
 *
 * It is a map *surface*: it reads the pipeline artifacts from `/raytracing/*` (+ the
 * `/api/emergency-services` feed) and reads NO store (INVARIANTS §2 — surfaces take
 * props, not the store). Layer visibility/opacity arrive as the `layers` prop from
 * {@link MapMount} (the one component that reads the store), wiring the left-rail
 * "Map Layers" toggles to the scene. Mounted as the centre-stage background in AppShell.
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
  PathLayer,
  ScatterplotLayer,
  IconLayer,
  TextLayer,
} from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Color, Position, Layer, LayersList } from "@deck.gl/core";
import type { Feature, GeoJSON, MultiPolygon, Polygon } from "geojson";
import type { LayerId, LayerState } from "@/lib/types";

// Which deck layer ids each left-rail toggle (LayerId) controls:
//   buildings → "buildings"
//   rays      → "rays"
//   masts     → "masts-lattice", "masts-dot"          (existing EE)
//   proposed  → "newmasts-lattice", "newmasts-dot"    (cuOpt-proposed)
//   deadzone  → "holes"
//   services  → "service-icons", "service-labels", + the service-colour fill on matched
//               footprints inside the "buildings" layer (recoloured when services flips)
//   labels    → "labels", "label-dots", + "service-labels" (station names are text labels,
//               so they hide when EITHER Emergency Services OR Labels is off)
type LayerVis = Record<LayerId, LayerState>;

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
const LOAD_GREEN: RGB = [43, 214, 118]; // low load
const LOAD_YELLOW: RGB = [255, 196, 72]; // mid load
const LOAD_RED: RGB = [255, 78, 68]; // high load
const HOLE_COLOR: RGB = [255, 70, 70];
const MATERIAL = {
  ambient: 0.1,
  diffuse: 0.6,
  shininess: 32,
  specularColor: [60, 64, 70] as RGB,
};

// ---- Antenna / mast styling -----------------------------------------------
// Masts render as a proper 3D lattice tower (the "red and white with lines" look): a
// tapered square lattice of polylines — four legs, horizontal rung rings and X-bracing,
// capped by a spire — banded in aviation red/white up its height. A coloured beacon dot
// tops each one (blue for existing EE masts, gold for cuOpt-proposed). The lattice geometry
// is ported from the retired Cesium SitefinderTowerLayer, rebuilt on a deck.gl PathLayer.
const MAST_WHITE: RGB = [232, 236, 244];
const MAST_RED: RGB = [226, 58, 53];
const MAST_DOT_EE: RGB = [40, 130, 255]; // blue beacon → existing EE masts
const MAST_DOT_NEW: RGB = [255, 200, 60]; // gold beacon → cuOpt-proposed masts
// Screen-space line widths (px) for the lattice members — legs boldest, bracing finest.
const LATTICE_LEG_W = 2.4;
const LATTICE_RUNG_W = 1.5;
const LATTICE_BRACE_W = 1.2;
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

// Almost every service is one OSM footprint and paints as such. A few hospitals are a single
// campus that OSM splits into many small footprints, so a normal match colours only the chunk
// under the address point. Those are hardcoded here: every unclaimed footprint whose centroid
// is within `radiusM` of the campus centre is painted. Kept deliberately small and explicit
// (rather than a geometric flood-fill) so it can't bleed into neighbours like The Shard and
// so no other hospital is affected. Centre = the dataset coordinate.
interface ServiceCampus {
  lat: number;
  lng: number;
  radiusM: number;
  note: string;
}
const SERVICE_CAMPUS: ServiceCampus[] = [
  { lat: 51.50333, lng: -0.08694, radiusM: 48, note: "Guy's Hospital (tower + podium core)" },
  { lat: 51.518, lng: -0.0588, radiusM: 45, note: "Royal London Hospital (modern tower complex)" },
];
// How close a service must be to a SERVICE_CAMPUS centre to be treated as that campus.
const SERVICE_CAMPUS_MATCH_M = 30;

// ---- Animation ------------------------------------------------------------
const LOOP_LENGTH = 1800;
const ANIMATION_SPEED = 1.2;
const TRAIL_LENGTH = 180;
const RAY_DURATION = 130;
const MAX_TRIPS = 700000; // cap rays for a clean, smooth field (above the 25-tile ring=13 ~550-600k output so every ray renders, step stays 1)

// Key London places within the simulated square (Bankside/Bermondsey in the west out to
// Canary Wharf/Greenwich), as orientation pointers. Each carries a `tier` — 0 = major
// hub/district, 1 = notable area/landmark, 2 = finer POI — which maps to a collision
// priority (LABEL_TIER_PRIORITY) so hubs win overlaps and finer names reveal on zoom-in.
type LandmarkTier = 0 | 1 | 2;
interface Landmark {
  name: string;
  lng: number;
  lat: number;
  tier: LandmarkTier;
}
const LANDMARKS: Landmark[] = [
  // Tier 0 — major hubs / districts, visible across the overview.
  { name: "City of London", lng: -0.091, lat: 51.515, tier: 0 },
  { name: "Canary Wharf", lng: -0.0195, lat: 51.505, tier: 0 },
  { name: "Shoreditch", lng: -0.078, lat: 51.5265, tier: 0 },
  { name: "Greenwich", lng: -0.009, lat: 51.481, tier: 0 },
  { name: "Bermondsey", lng: -0.064, lat: 51.498, tier: 0 },
  // Tier 1 — notable areas / landmarks, reveal at mid zoom.
  { name: "The Shard", lng: -0.0865, lat: 51.5045, tier: 1 },
  { name: "Tower Bridge", lng: -0.0754, lat: 51.5055, tier: 1 },
  { name: "Tower of London", lng: -0.0759, lat: 51.5081, tier: 1 },
  { name: "Liverpool St", lng: -0.0817, lat: 51.518, tier: 1 },
  { name: "Bank", lng: -0.0886, lat: 51.5134, tier: 1 },
  { name: "Borough Market", lng: -0.0908, lat: 51.5055, tier: 1 },
  { name: "Elephant & Castle", lng: -0.1003, lat: 51.4946, tier: 1 },
  { name: "Whitechapel", lng: -0.0613, lat: 51.5195, tier: 1 },
  { name: "Aldgate", lng: -0.0755, lat: 51.5143, tier: 1 },
  { name: "Wapping", lng: -0.0578, lat: 51.5043, tier: 1 },
  { name: "Bethnal Green", lng: -0.0553, lat: 51.527, tier: 1 },
  { name: "Hoxton", lng: -0.0807, lat: 51.532, tier: 1 },
  { name: "Limehouse", lng: -0.0386, lat: 51.5122, tier: 1 },
  { name: "Poplar", lng: -0.0176, lat: 51.5085, tier: 1 },
  { name: "Rotherhithe", lng: -0.0524, lat: 51.501, tier: 1 },
  { name: "Surrey Quays", lng: -0.0478, lat: 51.4933, tier: 1 },
  { name: "Deptford", lng: -0.0265, lat: 51.479, tier: 1 },
  { name: "Mile End", lng: -0.0334, lat: 51.5253, tier: 1 },
  // Tier 2 — finer POIs / streets, only on zoom-in.
  { name: "The Gherkin", lng: -0.0803, lat: 51.5145, tier: 2 },
  { name: "Monument", lng: -0.086, lat: 51.5101, tier: 2 },
  { name: "Fenchurch St", lng: -0.078, lat: 51.5115, tier: 2 },
  { name: "Spitalfields", lng: -0.0755, lat: 51.5193, tier: 2 },
  { name: "Brick Lane", lng: -0.0716, lat: 51.5219, tier: 2 },
  { name: "Columbia Road", lng: -0.07, lat: 51.53, tier: 2 },
  { name: "Shadwell", lng: -0.0568, lat: 51.5117, tier: 2 },
  { name: "Canada Water", lng: -0.0498, lat: 51.498, tier: 2 },
  { name: "West India Quay", lng: -0.022, lat: 51.507, tier: 2 },
  { name: "Mudchute", lng: -0.014, lat: 51.491, tier: 2 },
  { name: "Cutty Sark", lng: -0.0096, lat: 51.4827, tier: 2 },
];

// Google-Maps-style label declutter, done by the GPU collision filter rather than hard
// zoom gates: every label is always in the layer, but where two would overlap only the
// higher-priority (lower-tier) one draws. So the wide overview shows just the major hubs,
// and finer names reveal as you zoom in and they stop colliding. Tier → collision priority
// (range -1000..1000; higher wins) and on-screen text size.
const LABEL_TIER_PRIORITY: Record<LandmarkTier, number> = { 0: 80, 1: 40, 2: 0 };
const LABEL_TIER_SIZE: Record<LandmarkTier, number> = { 0: 13.5, 1: 12, 2: 10.5 };

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

const coordKey = (coord: number[]) => `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;

const loadHeatColor = (t: number): RGB => {
  const clamped = clamp01(t);
  if (clamped < 0.35) return mix(LOAD_GREEN, LOAD_YELLOW, clamped / 0.35);
  return mix(LOAD_YELLOW, LOAD_RED, (clamped - 0.35) / 0.65);
};

// Each ray becomes a deck.gl "trip": a path, per-vertex timestamps (a pulse that
// travels from the mast outward, staggered by a random phase), and a load-share colour.
function toTrips(fc: FC<RayFeature>): Trip[] {
  const feats = fc.features;
  const loadCounts = new Map<string, number>();
  for (const feature of feats) {
    const origin = feature.geometry.coordinates[0];
    if (!origin) continue;
    const key = coordKey(origin);
    loadCounts.set(key, (loadCounts.get(key) ?? 0) + 1);
  }
  // Rank masts by their ray count and colour each by its *percentile position*, not its
  // raw share. The per-mast counts are heavily skewed (a handful of hubs carry far more
  // rays than the long tail, plus one big outlier), so a raw share or normalise-by-max
  // ramp collapses almost every mast into the green band. Ranking spreads the green→red
  // heat evenly across masts so relative stress (busiest = red) actually reads.
  const ranked = [...loadCounts.entries()].sort((a, b) => a[1] - b[1]);
  const denom = Math.max(1, ranked.length - 1);
  const loadRank = new Map<string, number>();
  ranked.forEach(([key], i) => loadRank.set(key, i / denom));
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
    const color = loadHeatColor(loadRank.get(coordKey(coords[0])) ?? 0);
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

// Bind each in-bounds service to its building: paint the footprint(s) the point sits inside,
// or the nearest footprint whose centroid is within SERVICE_SNAP_M when none contains it. A
// service that matches a hardcoded SERVICE_CAMPUS also paints every unclaimed footprint within
// that campus radius, so a multi-footprint hospital (Guy's) shows as a whole rather than the
// single chunk under its address point — no other service is affected. Footprints already
// claimed by another service are left alone; services with no footprint in range are dropped.
// The pin sits over the largest footprint painted.
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
    const campus = SERVICE_CAMPUS.find(
      (c) => metresBetween(s.lng, s.lat, c.lng, c.lat) <= SERVICE_CAMPUS_MATCH_M,
    );
    const seeds: BuildingCell[] = [];
    const campusCells: BuildingCell[] = []; // extra footprints inside a hardcoded campus radius
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
      if (campus && metresBetween(campus.lng, campus.lat, c.cLng, c.cLat) <= campus.radiusM) {
        campusCells.push(c);
        continue;
      }
      const d = metresBetween(s.lng, s.lat, c.cLng, c.cLat);
      if (d < best) {
        best = d;
        nearest = c;
      }
    }
    if (seeds.length === 0 && nearest) seeds.push(nearest);
    const cluster = new Set<BuildingCell>([...seeds, ...campusCells]);
    if (cluster.size === 0) continue;
    let anchor: BuildingCell | null = null;
    for (const c of cluster) {
      c.feature.properties.service = s.type;
      if (!anchor || c.area > anchor.area) anchor = c;
    }
    if (!anchor) continue;
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

// One polyline member of a lattice tower: its world-space path, colour and pixel width.
interface LatticePath {
  path: Position[];
  color: RGB;
  width: number;
}

// The altitude (m) of the spire tip of a `vh`-metre mast — where the beacon dot sits.
// Mirrors the spire maths in latticeSegments so the dot caps the tower with no gap.
function mastTopZ(vh: number): number {
  const height = Math.max(14, vh);
  return height + Math.max(3, height * 0.14);
}

// Build the polyline members of one tapered square lattice tower anchored at `pos` and
// rising `vh` metres, appending them to `out`. Geometry ported from the retired Cesium
// SitefinderTowerLayer.buildLatticeTower: four legs, closed rung rings at each level,
// X-bracing across each face between levels, and a spire on top. The local east/north/up
// offsets (metres) are converted to lng/lat deltas + altitude so a single PathLayer can
// draw every tower in the field. Members are banded red/white up the height (aviation
// marking) — even levels red, odd white, rungs always white for contrast.
function latticeSegments(pos: Position, vh: number, out: LatticePath[]): void {
  const [lng, lat] = pos;
  const height = Math.max(14, vh);
  const baseHalf = Math.min(Math.max(height * 0.09, 3), 9); // slender, like a real mast
  const topHalf = baseHalf * 0.32;
  const mPerDegLat = 110540;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  // Local east(x)/north(y)/up(z) metre offset → [lng, lat, altitude-m].
  const world = (x: number, y: number, z: number): Position => [
    lng + x / mPerDegLng,
    lat + y / mPerDegLat,
    z,
  ];
  // Four corners of the square cross-section, tapering from baseHalf to topHalf.
  const signs: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const corner = (i: number, t: number): Position => {
    const [sx, sy] = signs[i];
    const half = baseHalf + (topHalf - baseHalf) * t;
    return world(sx * half, sy * half, height * t);
  };
  const ringPath = (t: number): Position[] => {
    const r = [corner(0, t), corner(1, t), corner(2, t), corner(3, t)];
    return [...r, r[0]];
  };

  const levels = Math.max(3, Math.round(height / 12));
  for (let l = 0; l < levels; l++) {
    const t0 = l / levels;
    const t1 = (l + 1) / levels;
    const band = l % 2 === 0 ? MAST_RED : MAST_WHITE;
    // Banded legs + X-bracing for this segment.
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      out.push({ path: [corner(i, t0), corner(i, t1)], color: band, width: LATTICE_LEG_W });
      out.push({ path: [corner(i, t0), corner(j, t1)], color: band, width: LATTICE_BRACE_W });
    }
    // Rung ring at the foot of the segment (white for contrast against the band).
    out.push({ path: ringPath(t0), color: MAST_WHITE, width: LATTICE_RUNG_W });
  }
  // Cap ring at the top + a red spire above the lattice head.
  out.push({ path: ringPath(1), color: MAST_WHITE, width: LATTICE_RUNG_W });
  out.push({
    path: [world(0, 0, height), world(0, 0, mastTopZ(vh))],
    color: MAST_RED,
    width: LATTICE_LEG_W,
  });
}

// One PathLayer drawing the red/white lattice towers for every site in `masts`. The
// members are pure screen-width polylines (no fill, no lighting) so the towers read as a
// crisp wireframe at any zoom. Real-world-sized geometry, built once into the static scene;
// the beacon dot that tops each mast is rebuilt per-frame (see buildMastDots).
function latticeTowers(idPrefix: string, masts: Mast[], st: LayerState): Layer[] {
  if (!masts.length) return [];
  const segs: LatticePath[] = [];
  for (const m of masts) latticeSegments(m.pos, m.vh, segs);
  return [
    new PathLayer<LatticePath>({
      id: `${idPrefix}-lattice`,
      data: segs,
      visible: st.visible,
      opacity: st.opacity,
      getPath: (d) => d.path,
      getColor: (d) => [...d.color, 255] as Color,
      getWidth: (d) => d.width,
      widthUnits: "pixels",
      widthMinPixels: 1,
      capRounded: true,
      jointRounded: true,
      pickable: false,
    }),
  ];
}

// The billboarded beacon dot atop each mast (blue = EE, gold = proposed), sized by the
// live zoom `scale` so it reads as a clear point up close and shrinks to a subtle speck
// on zoom-out. Rebuilt per frame against markerScale().
function buildMastDots(
  idPrefix: string,
  masts: Mast[],
  dot: RGB,
  scale: number,
  st: LayerState,
): ScatterplotLayer<Mast> {
  return new ScatterplotLayer<Mast>({
    id: `${idPrefix}-dot`,
    data: masts,
    visible: st.visible,
    opacity: st.opacity,
    billboard: true,
    radiusUnits: "pixels",
    // Sit exactly on the spire tip (no gap), and draw on top regardless of depth so the
    // beacon never gets occluded by the tower or nearby buildings when zoomed in.
    getPosition: (d) => [d.pos[0], d.pos[1], mastTopZ(d.vh)],
    getRadius: 5 * scale,
    radiusMinPixels: 3 * scale,
    radiusMaxPixels: 8 * scale,
    getFillColor: [...dot, 255] as Color,
    stroked: true,
    lineWidthMinPixels: 1.4,
    getLineColor: [8, 12, 18, 255],
    parameters: { depthCompare: "always" },
  });
}

// The static (non-animated) layers — buildings, antennas, holes and place labels. Built
// once and reused across animation frames so instance attributes aren't recomputed every
// tick; rebuilt only when a layer toggle/opacity changes (see the animate loop's gate).
// `vis` carries each toggle's visibility + opacity from the store.
function buildStaticLayers(data: SceneData, vis: LayerVis): LayersList {
  const L: LayersList = [];

  if (data.buildings)
    L.push(
      new GeoJsonLayer<BuildingProps>({
        id: "buildings",
        data: data.buildings,
        visible: vis.buildings.visible,
        extruded: true,
        wireframe: false,
        opacity: 0.92 * vis.buildings.opacity,
        material: MATERIAL,
        getElevation: (f) => f.properties.height || 9,
        // Always the plain short→tall height ramp here. A matched service footprint is
        // re-drawn opaque in the "service-buildings" overlay below, so its colour reads
        // cleanly instead of shimmering/z-fighting against overlapping grey footprints inside
        // this semi-transparent layer (which was making hospitals hard to see).
        getFillColor: (f) =>
          mix(
            BUILDING_SHORT,
            BUILDING_TALL,
            clamp01((f.properties.height || 9) / BUILDING_HEIGHT_REF),
          ),
        pickable: false,
      }),
    );

  // Emergency-service footprints, painted in the service colour as an OPAQUE overlay sitting
  // just above the grey massing and biased toward the camera (getPolygonOffset), so the colour
  // always wins the depth test rather than blending with the translucent buildings beneath or
  // z-fighting with overlapping grey footprints. Only present while Emergency Services is on;
  // with it off these footprints fall back to the grey ramp drawn by the buildings layer.
  const serviceFeatures =
    data.buildings && data.buildings.type === "FeatureCollection"
      ? data.buildings.features.filter((f) => (f.properties as BuildingProps | null)?.service)
      : [];
  if (serviceFeatures.length > 0 && vis.services.visible)
    L.push(
      new GeoJsonLayer<BuildingProps>({
        id: "service-buildings",
        data: { type: "FeatureCollection", features: serviceFeatures } as GeoJSON,
        visible: vis.buildings.visible,
        extruded: true,
        opacity: 1,
        material: MATERIAL,
        // +2 m so the coloured shell fully wraps its grey twin in the buildings layer.
        getElevation: (f) => (f.properties.height || 9) + 2,
        getFillColor: (f) =>
          f.properties.service
            ? ([...SERVICE_COLOR[f.properties.service], 255] as Color)
            : ([0, 0, 0, 0] as Color),
        getPolygonOffset: () => [-4, -4],
        pickable: false,
      }),
    );

  if (data.holes.length)
    L.push(
      new ScatterplotLayer<Hole>({
        id: "holes",
        data: data.holes,
        visible: vis.deadzone.visible,
        opacity: vis.deadzone.opacity,
        radiusUnits: "meters",
        radiusMinPixels: 2,
        getPosition: (d) => d.pos,
        getRadius: 30,
        getFillColor: [...HOLE_COLOR, 150] as Color,
        stroked: false,
      }),
    );

  // Emergency services: the colour-wrapped footprints are static; the floating map-pin
  // and the auto-revealing station name are both rebuilt per-frame against the live zoom
  // (buildServiceIcons / buildServiceLabels) so the pin shrinks on zoom-out.

  // Antennas: red/white 3D lattice towers sized to site height — EE follow the Cell Masts
  // toggle, cuOpt-proposed the Proposed Masts toggle. Their beacon dots (blue = EE, gold =
  // proposed) are rebuilt per-frame so they shrink on zoom-out (buildMastDots).
  L.push(...latticeTowers("masts", data.masts, vis.masts));
  L.push(...latticeTowers("newmasts", data.newMasts, vis.proposed));

  // Place labels are NOT built here: they're rebuilt per-frame from the viewport-decluttered
  // set (declutterLabels / buildLabelLayers) and appended last so they sit on top.

  return L;
}

// Service names reveal automatically once the camera is zoomed in past this level —
// "in proximity" — and hide again on zoom-out so the wide view stays uncluttered.
const SERVICE_LABEL_ZOOM = 14;

// Markers (service pins + mast beacon dots) shrink toward a floor as the camera pulls
// back, so the wide view reads as a calm overview and only fills in marker detail on
// zoom-in. Eased smoothly between MIN (fully shrunk) and FULL (full size) zoom.
const MARKER_MIN_ZOOM = 12; // at/below: markers at their minimum size
const MARKER_FULL_ZOOM = 14.5; // at/above: markers at full size
const MARKER_MIN_SCALE = 0.34; // smallest fraction of full size when zoomed right out

// 0..1 size factor for the live zoom, never dropping below MARKER_MIN_SCALE so pins/dots
// stay as subtle points rather than vanishing entirely when far out.
function markerScale(zoom: number): number {
  const t = clamp01((zoom - MARKER_MIN_ZOOM) / (MARKER_FULL_ZOOM - MARKER_MIN_ZOOM));
  return MARKER_MIN_SCALE + (1 - MARKER_MIN_SCALE) * t;
}

// The emergency-service map-pins, sized by the live zoom `scale` so they shrink on
// zoom-out alongside the mast dots. Rebuilt per frame against markerScale().
function buildServiceIcons(
  markers: Marker[],
  scale: number,
  st: LayerState,
): IconLayer<Marker> {
  return new IconLayer<Marker>({
    id: "service-icons",
    data: markers,
    visible: st.visible,
    opacity: st.opacity,
    billboard: true,
    sizeUnits: "pixels",
    getIcon: (d) => SERVICE_ICON[d.type],
    getPosition: (d) => [d.pos[0], d.pos[1], d.h + 6],
    getSize: 34 * scale,
    sizeMinPixels: 20 * scale,
    sizeMaxPixels: 46 * scale,
    pickable: false,
  });
}

// Name labels for every service pin. Shown only when `nearEnough` (the live zoom is past
// SERVICE_LABEL_ZOOM) AND both the Emergency Services and Labels toggles are on — these
// names are emergency-service text, so they answer to either toggle being switched off.
// Rebuilt per-frame so it tracks zoom without rebuilding the scene.
function buildServiceLabels(
  markers: Marker[],
  nearEnough: boolean,
  services: LayerState,
  labels: LayerState,
): TextLayer<Marker> {
  return new TextLayer<Marker>({
    id: "service-labels",
    data: nearEnough ? markers : [],
    visible: services.visible && labels.visible,
    opacity: services.opacity * labels.opacity,
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

// CPU-side label declutter (the GPU CollisionFilterExtension does not render under our
// non-interleaved MapboxOverlay, so we deconflict ourselves). Given the live map, project
// every landmark to screen pixels, then greedily keep labels in priority order (major hubs
// first) — skipping any whose padded text box overlaps one already kept. The result is the
// Google-Maps declutter: only the hubs survive in the wide view, and finer names reveal as
// you zoom in and the points spread apart. Recomputed only when the viewport changes.
const LABEL_PAD_PX = 6; // extra air around each text box when testing overlap
const labelPriority = (d: Landmark) => LABEL_TIER_PRIORITY[d.tier];
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
function declutterLabels(map: maplibregl.Map): Landmark[] {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ordered = [...LANDMARKS].sort((a, b) => labelPriority(b) - labelPriority(a));
  const kept: Landmark[] = [];
  const boxes: Box[] = [];
  for (const d of ordered) {
    const p = map.project([d.lng, d.lat]);
    // Drop anything well off-screen (with a margin) so off-view labels don't crowd the test.
    if (p.x < -200 || p.x > width + 200 || p.y < -200 || p.y > height + 200) continue;
    const size = LABEL_TIER_SIZE[d.tier];
    const w = d.name.length * size * 0.6 + 12; // rough text width incl. background padding
    const h = size + 8;
    const cx = p.x;
    const cy = p.y - 12; // mirror the label's -12px vertical offset
    const box: Box = {
      minX: cx - w / 2 - LABEL_PAD_PX,
      minY: cy - h / 2 - LABEL_PAD_PX,
      maxX: cx + w / 2 + LABEL_PAD_PX,
      maxY: cy + h / 2 + LABEL_PAD_PX,
    };
    const hits = boxes.some(
      (b) => box.minX < b.maxX && box.maxX > b.minX && box.minY < b.maxY && box.maxY > b.minY,
    );
    if (hits) continue;
    kept.push(d);
    boxes.push(box);
  }
  return kept;
}

// The place labels + the major-hub anchor dots, drawn for the already-deconflicted `shown`
// set (see declutterLabels). A cyan dot marks the tier-0 hubs only; major hubs render a
// touch larger than finer POIs. `shown` only changes when the viewport changes, so the
// per-frame rebuild reuses a stable array and deck.gl skips re-tessellating the text.
function buildLabelLayers(
  shown: Landmark[],
  st: LayerState,
): [ScatterplotLayer<Landmark>, TextLayer<Landmark>] {
  return [
    new ScatterplotLayer<Landmark>({
      id: "label-dots",
      data: shown.filter((d) => d.tier === 0),
      visible: st.visible,
      opacity: st.opacity,
      getPosition: (d) => [d.lng, d.lat],
      radiusUnits: "meters",
      getRadius: 42,
      radiusMinPixels: 2.5,
      radiusMaxPixels: 6,
      getFillColor: [33, 212, 253, 230],
      stroked: true,
      lineWidthMinPixels: 1.2,
      getLineColor: [8, 12, 18, 255],
    }),
    new TextLayer<Landmark>({
      id: "labels",
      data: shown,
      visible: st.visible,
      opacity: st.opacity,
      getPosition: (d) => [d.lng, d.lat],
      getText: (d) => d.name,
      getSize: (d) => LABEL_TIER_SIZE[d.tier],
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
  ];
}

// The single animated layer — the signal-ray trips, advanced each frame by `time`,
// coloured by per-mast load rank (see toTrips).
function buildRaysLayer(trips: Trip[], time: number, st: LayerState): TripsLayer<Trip> {
  return new TripsLayer<Trip>({
    id: "rays",
    data: trips,
    visible: st.visible,
    getPath: (d) => d.path,
    getTimestamps: (d) => d.timestamps,
    getColor: (d) => d.color,
    opacity: 0.8 * st.opacity,
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

// A short signature of just the layer states that affect the *static* layers
// (buildings / masts / proposed / deadzone), so the animate loop only rebuilds those — an
// expensive operation (re-tessellates the lattice towers) — when one of those toggles or
// opacities actually changes, not every frame. The services *visibility* is included too
// (on/off only — not its opacity) because it recolours matched footprints in the static
// buildings layer; the service pins/names and place labels are per-frame layers.
function staticSig(l: LayerVis): string {
  const groups = (["buildings", "masts", "proposed", "deadzone"] as const)
    .map((k) => `${l[k].visible ? 1 : 0}:${l[k].opacity}`)
    .join("|");
  return `${groups}|svc:${l.services.visible ? 1 : 0}`;
}

export function DeckScene({ layers }: { layers: LayerVis }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The map is built once in an effect that never re-runs; the animate loop reads the
  // latest layer states through this ref so toggles take effect without remounting the map.
  // Synced from props in its own effect (refs must not be written during render).
  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

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

      // Static layers are rebuilt only when a layer toggle/opacity changes (tracked by
      // staticSig); the rays, mast beacon dots and service pins/names rebuild every frame
      // (they animate or track zoom) and read their visibility straight from layersRef.
      let staticLayers = buildStaticLayers(data, layersRef.current);
      let lastSig = staticSig(layersRef.current);

      // The decluttered place-label set is recomputed only when the viewport actually moves
      // (zoom/pan/rotate), then reused across frames so the per-frame rebuild hands deck.gl a
      // stable `data` array and it skips re-tessellating the text.
      let shownLabels: Landmark[] = declutterLabels(map!);
      let lastLabelView = "";
      const labelViewKey = () => {
        const c = map!.getCenter();
        return `${map!.getZoom().toFixed(2)}|${c.lng.toFixed(4)}|${c.lat.toFixed(4)}|${map!.getBearing().toFixed(1)}|${map!.getPitch().toFixed(1)}`;
      };

      let time = 0;
      const animate = () => {
        if (cancelled || !overlay) return;
        time = (time + ANIMATION_SPEED) % LOOP_LENGTH;
        const L = layersRef.current;
        const sig = staticSig(L);
        if (sig !== lastSig) {
          staticLayers = buildStaticLayers(data, L);
          lastSig = sig;
        }
        const zoom = map?.getZoom() ?? 0;
        const nearEnough = zoom >= SERVICE_LABEL_ZOOM;
        const scale = markerScale(zoom);
        const vk = labelViewKey();
        if (vk !== lastLabelView) {
          shownLabels = declutterLabels(map!);
          lastLabelView = vk;
        }
        overlay.setProps({
          layers: [
            ...staticLayers,
            buildRaysLayer(data.trips, time, L.rays),
            buildMastDots("masts", data.masts, MAST_DOT_EE, scale, L.masts),
            buildMastDots("newmasts", data.newMasts, MAST_DOT_NEW, scale, L.proposed),
            buildServiceIcons(data.markers, scale, L.services),
            buildServiceLabels(data.markers, nearEnough, L.services, L.labels),
            // Place labels last so they sit on top; deconflicted CPU-side per viewport.
            ...buildLabelLayers(shownLabels, L.labels),
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

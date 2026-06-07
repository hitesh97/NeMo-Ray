"use client";

/**
 * DeckScene — the live 3D coverage twin, ported from the standalone deck.gl
 * viewer (`viewer/app.js`, "trips" theme by Mehul Chourasia) into the HUD.
 *
 * Animated ray traces (TripsLayer) coloured by antenna load share (yellow = light,
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
  PolygonLayer,
  ScatterplotLayer,
  IconLayer,
  LineLayer,
  TextLayer,
  BitmapLayer,
} from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Color, Position, Layer, LayersList } from "@deck.gl/core";
import type { Feature, GeoJSON, MultiPolygon, Polygon } from "geojson";
import type {
  AgentMapState,
  BBox,
  CameraCommand,
  LayerId,
  LayerState,
  LngLat,
  MapMarker,
  MapZone,
} from "@/lib/types";

// Which deck layer ids each left-rail toggle (LayerId) controls:
//   buildings → "buildings"
//   rays      → "rays"
//   masts     → "masts-lattice", "masts-dot"          (existing EE)
//               + "masts-hit" (invisible click target → reference a mast in chat)
//               + "masts-ref" (pulsing ring on masts referenced in the composer)
//   proposed  → "newmasts-lattice", "newmasts-dot"    (cuOpt-proposed)
//   deadzone  → "holes"
//   coverage  → "coverage"  (the dBm best-server heatmap raster, coverage.png; default off)
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
const LOAD_YELLOW: RGB = [255, 225, 107]; // light coverage stress
const LOAD_RED: RGB = [192, 57, 43]; // heavy coverage stress (dimmed brick red, was [255,78,68])
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
const MAST_REF_RING: RGB = [255, 120, 40]; // amber ring → mast referenced in the chat composer
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
  properties: { height_m?: number; id?: string };
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
// A sited antenna: ground position, the metres-tall it should render at (`vh`), and the
// site id (`id`) so a click can reference it back to the network/agent.
interface Mast {
  pos: Position;
  vh: number;
  id?: string;
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
  bounds: Bounds | null;
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

// Yellow (light coverage stress) → red (heavy coverage stress).
const loadHeatColor = (t: number): RGB => mix(LOAD_YELLOW, LOAD_RED, clamp01(t));

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
  // ramp collapses almost every mast into the yellow band. Ranking spreads the yellow→red
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
    out.push({ pos: [lng, lat], vh, id: f.properties.id });
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

// Invisible oversized click targets over the EE masts: a generous pixel disc on each beacon so
// the operator can click an antenna to reference it in the chat composer ("take it down"). Only
// built when the masts layer is visible, so hidden masts aren't clickable. Mirrors the satellite
// "sat-hit" pattern. `onPick` is read from a ref so the once-built map picks up the latest store
// callback without remounting.
function buildMastHits(
  masts: Mast[],
  scale: number,
  onPick: (id: string) => void,
): ScatterplotLayer<Mast> {
  return new ScatterplotLayer<Mast>({
    id: "masts-hit",
    data: masts,
    billboard: true,
    radiusUnits: "pixels",
    getPosition: (d) => [d.pos[0], d.pos[1], mastTopZ(d.vh)],
    getRadius: 14 * scale,
    radiusMinPixels: 10,
    radiusMaxPixels: 22,
    getFillColor: [0, 0, 0, 0] as Color,
    stroked: false,
    pickable: true,
    onClick: (info) => {
      const id = info.object?.id;
      if (id) onPick(id);
    },
    parameters: { depthCompare: "always" },
  });
}

// A pulsing amber ring around any mast currently referenced in the chat composer, so the
// operator's selection reads on the map. `pulse` (0..1) drives the radius/opacity throb.
function buildMastRefRings(
  masts: Mast[],
  referenced: Set<string>,
  scale: number,
  pulse: number,
): ScatterplotLayer<Mast> {
  const data = masts.filter((m) => m.id && referenced.has(m.id));
  return new ScatterplotLayer<Mast>({
    id: "masts-ref",
    data,
    billboard: true,
    radiusUnits: "pixels",
    getPosition: (d) => [d.pos[0], d.pos[1], mastTopZ(d.vh)],
    getRadius: (9 + 3 * pulse) * scale,
    radiusMinPixels: 8,
    radiusMaxPixels: 26,
    getFillColor: [0, 0, 0, 0] as Color,
    stroked: true,
    lineWidthMinPixels: 2,
    getLineColor: [...MAST_REF_RING, Math.round(170 + 85 * pulse)] as Color,
    parameters: { depthCompare: "always" },
    updateTriggers: { getRadius: pulse, getLineColor: pulse },
  });
}

// The static (non-animated) layers — buildings, antennas, holes and place labels. Built
// once and reused across animation frames so instance attributes aren't recomputed every
// tick; rebuilt only when a layer toggle/opacity changes (see the animate loop's gate).
// `vis` carries each toggle's visibility + opacity from the store.
function buildStaticLayers(data: SceneData, vis: LayerVis): LayersList {
  const L: LayersList = [];

  // Coverage heatmap (dBm best-server raster, coverage.png) draped at ground level so the
  // extruded buildings + ray field sit above it. Default off (see DEFAULT_LAYERS.coverage).
  if (data.bounds)
    L.push(
      new BitmapLayer({
        id: "coverage",
        image: `${DATA}/coverage.png`,
        bounds: [data.bounds.west, data.bounds.south, data.bounds.east, data.bounds.north],
        visible: vis.coverage.visible,
        opacity: vis.coverage.opacity,
        pickable: false,
      }),
    );

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
// Map the canonical gazetteer (/geo/landmarks.json — the single source of truth the Nemotron
// agent's knowledge graph also reads) down to the map's label set: only entries flagged
// `label: true` are drawn, carrying their `tier`. Falls back to the hardcoded LANDMARKS if the
// fetch fails or yields nothing, so the labels never disappear.
interface GazetteerEntry {
  name: string;
  lng: number;
  lat: number;
  tier?: LandmarkTier;
  label?: boolean;
}
function toLabelLandmarks(raw: unknown): Landmark[] {
  const places = (raw as { places?: GazetteerEntry[] } | null)?.places;
  if (!Array.isArray(places)) return LANDMARKS;
  const out: Landmark[] = places
    .filter((p) => p?.label && typeof p.lng === "number" && typeof p.lat === "number")
    .map((p) => ({ name: p.name, lng: p.lng, lat: p.lat, tier: (p.tier ?? 2) as LandmarkTier }));
  return out.length ? out : LANDMARKS;
}

function declutterLabels(map: maplibregl.Map, landmarks: Landmark[]): Landmark[] {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ordered = [...landmarks].sort((a, b) => labelPriority(b) - labelPriority(a));
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

// Ray thickness (px) tapers with the live zoom so the trails read as crisp threads when
// zoomed right out (where a fixed pixel width looked chunky against the shrunken scene) and
// fill out to full weight up close. Eased between MIN and FULL zoom like markerScale().
const RAY_MIN_ZOOM = 10; // at/below: rays at their thinnest
const RAY_FULL_ZOOM = 14; // at/above: rays at full width
const RAY_WIDTH_MIN = 0.5; // px width when zoomed right out
const RAY_WIDTH_FULL = 2.4; // px width up close
function rayWidth(zoom: number): number {
  const t = clamp01((zoom - RAY_MIN_ZOOM) / (RAY_FULL_ZOOM - RAY_MIN_ZOOM));
  return RAY_WIDTH_MIN + (RAY_WIDTH_FULL - RAY_WIDTH_MIN) * t;
}

// The single animated layer — the signal-ray trips, advanced each frame by `time`,
// coloured by per-mast load rank (see toTrips). Width tapers with `zoom` (rayWidth).
function buildRaysLayer(
  trips: Trip[],
  time: number,
  zoom: number,
  st: LayerState,
): TripsLayer<Trip> {
  const w = rayWidth(zoom);
  return new TripsLayer<Trip>({
    id: "rays",
    data: trips,
    visible: st.visible,
    getPath: (d) => d.path,
    getTimestamps: (d) => d.timestamps,
    getColor: (d) => d.color,
    opacity: 0.8 * st.opacity,
    widthUnits: "pixels",
    getWidth: w,
    widthMinPixels: 1,
    updateTriggers: { getWidth: w },
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
// ---- Agent-driven highlights (map_action directives) ----------------------
// The Nemotron agent's tools stream map_action frames; MapMount folds them into
// AgentMapState and passes it here as `directives`. These layers draw on top of
// everything (depthTest off) and pulse, so an outage's dead-zone ground, the COW +
// its source fire station, and a located building read instantly. Always-on (not
// gated by the left-rail toggles) — they appear only when the agent sets them.
const HL_ZONE: RGB = [255, 64, 64]; // dead-zone ground
const HL_BUILDING: RGB = [255, 209, 64]; // located / affected building (amber)
const HL_COW: RGB = [80, 220, 130]; // Cell-on-Wheels (green)
const HL_STATION: RGB = [255, 96, 96]; // COW source (fire station, red)
const HL_ROUTE: RGB = [120, 200, 255]; // tow route (blue)

const EMPTY_DIRECTIVES: AgentMapState = {
  zones: [],
  markers: [],
  cow: null,
  station: null,
  route: null,
  focus: null,
};

// Stable empty default for the referencedSiteIds prop (avoids a new array each render).
const EMPTY_REF_IDS: string[] = [];

function bboxRing(b: BBox): Position[] {
  const [w, s, e, n] = b;
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
}
function circleRing(center: LngLat, radiusKm: number, steps = 56): Position[] {
  const [lng, lat] = center;
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180) || 1e-6);
  const ring: Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}
function markerColor(kind: MapMarker["kind"]): RGB {
  switch (kind) {
    case "cow":
      return HL_COW;
    case "station":
      return HL_STATION;
    case "proposal":
      return MAST_DOT_NEW; // gold — matches cuOpt-proposed masts
    default:
      return HL_BUILDING; // building / poi
  }
}

// Build the agent overlay layers for the current directive state. Rebuilt each frame so
// the rings/zones can pulse; cheap (a handful of small features). `time` drives the pulse.
function buildDirectiveLayers(d: AgentMapState, time: number): LayersList {
  const layers: Layer[] = [];
  const pulse = 0.5 + 0.5 * Math.sin(time * 0.06); // 0..1
  // luma.gl v9 parameter: draw the highlights on top of the scene (no depth rejection
  // against buildings) so a dead zone / COW / building marker is never occluded.
  const noDepth = { depthCompare: "always" } as const;

  if (d.zones.length) {
    layers.push(
      new PolygonLayer<MapZone>({
        id: "agent-zones",
        data: d.zones,
        getPolygon: (z) => (z.polygon ? (z.polygon as Position[]) : z.bbox ? bboxRing(z.bbox) : []),
        stroked: true,
        filled: true,
        extruded: false,
        getFillColor: [...HL_ZONE, Math.round(36 + 64 * pulse)] as Color,
        getLineColor: [...HL_ZONE, 230] as Color,
        lineWidthMinPixels: 1.5,
        parameters: noDepth,
        pickable: false,
      }),
    );
  }

  if (d.cow?.radiusKm) {
    const cow = d.cow;
    layers.push(
      new PolygonLayer<MapMarker>({
        id: "agent-cow-disc",
        data: [cow],
        getPolygon: (m) => circleRing(m.position, m.radiusKm ?? 1),
        stroked: true,
        filled: true,
        extruded: false,
        getFillColor: [...HL_COW, Math.round(20 + 28 * pulse)] as Color,
        getLineColor: [...HL_COW, 200] as Color,
        lineWidthMinPixels: 1.5,
        parameters: noDepth,
        pickable: false,
      }),
    );
  }

  if (d.route && d.route.length >= 2) {
    layers.push(
      new PathLayer<Position[]>({
        id: "agent-route",
        data: [d.route as Position[]],
        getPath: (p) => p,
        getColor: [...HL_ROUTE, 235] as Color,
        getWidth: 4,
        widthMinPixels: 2.5,
        widthMaxPixels: 6,
        capRounded: true,
        jointRounded: true,
        parameters: noDepth,
        pickable: false,
      }),
    );
  }

  const footprints = d.markers.filter((m) => m.footprint && m.footprint.length >= 3);
  if (footprints.length) {
    layers.push(
      new PolygonLayer<MapMarker>({
        id: "agent-footprints",
        data: footprints,
        getPolygon: (m) => m.footprint as Position[],
        stroked: true,
        filled: true,
        extruded: false,
        getFillColor: [...HL_BUILDING, 64] as Color,
        getLineColor: [...HL_BUILDING, 240] as Color,
        lineWidthMinPixels: 2,
        parameters: noDepth,
        pickable: false,
      }),
    );
  }

  const markers: MapMarker[] = [
    ...d.markers,
    ...(d.station ? [d.station] : []),
    ...(d.cow ? [d.cow] : []),
  ];
  if (markers.length) {
    layers.push(
      new ScatterplotLayer<MapMarker>({
        id: "agent-marker-ring",
        data: markers,
        getPosition: (m) => m.position,
        stroked: true,
        filled: false,
        getLineColor: (m) => [...markerColor(m.kind), 235] as Color,
        getRadius: 1,
        radiusUnits: "pixels",
        lineWidthMinPixels: 2 + 2 * pulse,
        radiusMinPixels: 11 + 7 * pulse,
        radiusMaxPixels: 44,
        parameters: noDepth,
        pickable: false,
      }),
    );
    layers.push(
      new ScatterplotLayer<MapMarker>({
        id: "agent-marker-dot",
        data: markers,
        getPosition: (m) => m.position,
        filled: true,
        getFillColor: (m) => [...markerColor(m.kind), 255] as Color,
        getRadius: 1,
        radiusUnits: "pixels",
        radiusMinPixels: 4,
        radiusMaxPixels: 8,
        parameters: noDepth,
        pickable: false,
      }),
    );
    layers.push(
      new TextLayer<MapMarker>({
        id: "agent-marker-label",
        data: markers,
        getPosition: (m) => m.position,
        getText: (m) => m.label ?? "",
        getSize: 12,
        sizeUnits: "pixels",
        getColor: [240, 244, 252, 255] as Color,
        getPixelOffset: [0, -22],
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        getTextAnchor: "middle",
        getAlignmentBaseline: "bottom",
        background: true,
        getBackgroundColor: [10, 14, 22, 205] as Color,
        backgroundPadding: [5, 3],
        characterSet: "auto",
        parameters: noDepth,
        pickable: false,
      }),
    );
  }

  return layers;
}

function staticSig(l: LayerVis): string {
  const groups = (["buildings", "masts", "proposed", "deadzone", "coverage"] as const)
    .map((k) => `${l[k].visible ? 1 : 0}:${l[k].opacity}`)
    .join("|");
  return `${groups}|svc:${l.services.visible ? 1 : 0}`;
}

// ---- Starlink constellation -------------------------------------------------
// Live satellite positions come from `/api/starlink` (SGP4 over the bundled TLE set),
// refreshed every 15 s; between refreshes the animate loop extrapolates each satellite
// forward from its last snapshot + averaged velocity so the constellation drifts
// continuously instead of jumping. Satellites render at the UK framing (they fade out as you
// dive to London, gone by zoom 8), reachable via the CameraViewPanel "satellite" button
// (camera "flyToGlobe" — now a UK pull-out, not a world globe).

// London centroid used for nearest-satellite calculations.
const LONDON_LAT = 51.5074;
const LONDON_LON = -0.1278;

// Position type matching the /api/starlink response.
interface SatellitePosition {
  name: string;
  norad_id: number;
  lon: number;
  lat: number;
  altitude_km: number;
}

// Returns the satellite whose 3D slant range to London is smallest.
function nearestSatToLondon(sats: SatellitePosition[]): SatellitePosition | null {
  if (!sats.length) return null;
  let nearest = sats[0];
  let bestDist = Infinity;
  for (const s of sats) {
    const midLat = (((s.lat + LONDON_LAT) / 2) * Math.PI) / 180;
    const dx = ((s.lon - LONDON_LON) * 111320 * Math.cos(midLat)) / 1000; // km
    const dy = ((s.lat - LONDON_LAT) * 110540) / 1000; // km
    const dist = Math.sqrt(dx * dx + dy * dy + s.altitude_km * s.altitude_km);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = s;
    }
  }
  return nearest;
}

// Estimates round-trip latency (ms) as 2 × slant-range / speed-of-light + 15 ms overhead.
function estimateLatencyMs(sat: SatellitePosition): number {
  const midLat = (((sat.lat + LONDON_LAT) / 2) * Math.PI) / 180;
  const dx = ((sat.lon - LONDON_LON) * 111320 * Math.cos(midLat)) / 1000;
  const dy = ((sat.lat - LONDON_LAT) * 110540) / 1000;
  const slantRange = Math.sqrt(dx * dx + dy * dy + sat.altitude_km * sat.altitude_km);
  // 300 km/ms ≈ speed of light; +15 ms accounts for routing & processing overhead.
  return Math.round((2 * slantRange) / 300 + 15);
}

const SAT_ICON_DESCRIPTOR = {
  url: "/icons/satellite.svg",
  width: 128,
  height: 64,
  anchorX: 64,
  anchorY: 32,
  mask: false,
};

// Each API refresh stores a position snapshot per satellite; the last-known velocity
// (averaged across up to 3 consecutive snapshots) extrapolates positions forward between
// refreshes. On first sight (no consecutive snapshots yet) a satellite is seeded with a
// physics-derived velocity so it moves immediately; the second snapshot overwrites it.
interface SatSnapshot {
  lon: number;
  lat: number;
  alt: number; // km
  t: number; // Date.now() when fetched
}
interface SatTrack {
  history: SatSnapshot[]; // oldest-first, max 3 entries
  velLon: number; // average velocity in °/ms
  velLat: number;
  velAlt: number; // km/ms
}

// Earth's gravitational parameter (km³/s²) and Starlink shell-1 inclination.
const GM_EARTH = 398600;
const STARLINK_INC_RAD = 53 * (Math.PI / 180);

// Two-body estimate of (velLon, velLat) in °/ms for a satellite at (lat, alt_km), from the
// spherical-orbit ground-track equations (+ ascending / − descending node).
function approximateOrbitalVelocity(
  lat: number,
  alt_km: number,
  ascending: boolean,
): [number, number] {
  const r = 6371 + alt_km;
  const omegaDegMs = (Math.sqrt(GM_EARTH / (r * r * r)) * (180 / Math.PI)) / 1000;
  const sinLat = Math.sin(lat * (Math.PI / 180));
  const cosLat = Math.cos(lat * (Math.PI / 180));
  const sinInc = Math.sin(STARLINK_INC_RAD);
  const cosInc = Math.cos(STARLINK_INC_RAD);
  const velLon = (omegaDegMs * cosInc) / Math.max(cosLat, 0.1);
  const velLat =
    (ascending ? 1 : -1) * omegaDegMs * Math.sqrt(Math.max(0, sinInc * sinInc - sinLat * sinLat));
  return [velLon, velLat];
}

// Merge a fresh batch of positions into the per-satellite tracks, updating averaged velocity.
function updateSatTracks(
  tracks: Map<string, SatTrack>,
  newSats: SatellitePosition[],
  now: number,
): void {
  for (const sat of newSats) {
    const snap: SatSnapshot = { lon: sat.lon, lat: sat.lat, alt: sat.altitude_km, t: now };
    const prev = tracks.get(sat.name);
    if (!prev) {
      const [velLon, velLat] = approximateOrbitalVelocity(
        sat.lat,
        sat.altitude_km,
        // Seed node direction deterministically from the name so it doesn't reshuffle.
        (sat.name.charCodeAt(0) & 1) === 0,
      );
      tracks.set(sat.name, { history: [snap], velLon, velLat, velAlt: 0 });
      continue;
    }
    const history = [...prev.history, snap].slice(-3);
    let vLon = 0,
      vLat = 0,
      vAlt = 0,
      n = 0;
    for (let i = 1; i < history.length; i++) {
      const dt = history[i].t - history[i - 1].t;
      if (dt > 500) {
        vLon += (history[i].lon - history[i - 1].lon) / dt;
        vLat += (history[i].lat - history[i - 1].lat) / dt;
        vAlt += (history[i].alt - history[i - 1].alt) / dt;
        n++;
      }
    }
    tracks.set(sat.name, {
      history,
      velLon: n > 0 ? vLon / n : prev.velLon,
      velLat: n > 0 ? vLat / n : prev.velLat,
      velAlt: n > 0 ? vAlt / n : prev.velAlt,
    });
  }
}

// Extrapolate every satellite forward from its last snapshot using averaged velocity.
function interpolatedPositions(tracks: Map<string, SatTrack>, now: number): SatellitePosition[] {
  const result: SatellitePosition[] = [];
  for (const [name, track] of tracks) {
    const last = track.history[track.history.length - 1];
    const dt = now - last.t;
    let lon = last.lon + track.velLon * dt;
    const lat = Math.max(-90, Math.min(90, last.lat + track.velLat * dt));
    const altitude_km = Math.max(0, last.alt + track.velAlt * dt);
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    result.push({ name, norad_id: 0, lon, lat, altitude_km });
  }
  return result;
}

// Inter-satellite link segments for the constellation grid overlay. Samples up to
// MAX_SAT_SAMPLE evenly to keep the O(n²) neighbour search fast, then connects each
// sampled satellite to its 2 nearest neighbours.
interface SatLink {
  from: Position;
  to: Position;
}
const MAX_SAT_SAMPLE = 250;

function buildSatelliteLinks(sats: SatellitePosition[]): SatLink[] {
  const step = Math.max(1, Math.floor(sats.length / MAX_SAT_SAMPLE));
  const sample: SatellitePosition[] = [];
  for (let i = 0; i < sats.length && sample.length < MAX_SAT_SAMPLE; i += step) sample.push(sats[i]);

  const links: SatLink[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sample.length; i++) {
    const a = sample[i];
    const dists: { j: number; d: number }[] = [];
    for (let j = 0; j < sample.length; j++) {
      if (i === j) continue;
      const b = sample[j];
      let dLon = b.lon - a.lon;
      if (dLon > 180) dLon -= 360;
      else if (dLon < -180) dLon += 360;
      const dLat = b.lat - a.lat;
      dists.push({ j, d: dLon * dLon + dLat * dLat });
    }
    dists.sort((x, y) => x.d - y.d);
    for (const { j } of dists.slice(0, 2)) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        from: [a.lon, a.lat, a.altitude_km * 1000] as Position,
        to: [sample[j].lon, sample[j].lat, sample[j].altitude_km * 1000] as Position,
      });
    }
  }
  return links;
}

// Satellite layers: inter-sat links + SVG billboard icon + sub-pixel dot + an oversized
// invisible hit target + the nearest-to-London label (name + estimated latency). `opacity`
// (supplied per-frame, 1 at globe zoom → 0 at London zoom) fades the whole set out on zoom-in.
function buildSatelliteLayers(
  sats: SatellitePosition[],
  opacity: number,
  zoom: number,
  onClickSat: (sat: SatellitePosition) => void,
): Layer[] {
  if (!sats.length || opacity <= 0) return [];
  // ~13–14 px across the UK framing (zoom ~4.7+); shrinks toward 5 px on dive-in. Clamped [5, 14].
  const iconSize = Math.round(Math.max(5, Math.min(14, 4 + zoom * 2)));
  interface SatDatum {
    pos: Position;
    name: string;
    sat: SatellitePosition;
  }
  const data: SatDatum[] = sats.map((s) => ({
    pos: [s.lon, s.lat, s.altitude_km * 1000] as Position,
    name: s.name,
    sat: s,
  }));
  const links = buildSatelliteLinks(sats);
  const nearest = nearestSatToLondon(sats);
  const nearestDatum: SatDatum[] = nearest
    ? [
        {
          pos: [nearest.lon, nearest.lat, nearest.altitude_km * 1000] as Position,
          name: nearest.name,
          sat: nearest,
        },
      ]
    : [];
  const latencyMs = nearest ? estimateLatencyMs(nearest) : 0;
  return [
    new LineLayer<SatLink>({
      id: "sat-links",
      data: links,
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: [80, 160, 255, Math.round(opacity * 45)] as Color,
      getWidth: 1,
      widthUnits: "pixels",
      widthMinPixels: 0.5,
      widthMaxPixels: 1.2,
    }),
    new IconLayer<SatDatum>({
      id: "sat-icons",
      data,
      billboard: true,
      getIcon: () => SAT_ICON_DESCRIPTOR,
      getPosition: (d) => d.pos,
      getSize: iconSize,
      sizeUnits: "pixels",
      sizeMinPixels: 4,
      sizeMaxPixels: iconSize,
      opacity,
      pickable: false,
    }),
    // Invisible oversized hit target — a 24 px click zone regardless of icon size.
    new ScatterplotLayer<SatDatum>({
      id: "sat-hit",
      data,
      billboard: true,
      radiusUnits: "pixels",
      getPosition: (d) => d.pos,
      getRadius: 24,
      radiusMinPixels: 24,
      radiusMaxPixels: 24,
      getFillColor: [0, 0, 0, 0] as Color,
      stroked: false,
      pickable: true,
      onClick: (info) => {
        if (info.object) onClickSat(info.object.sat);
      },
    }),
    new ScatterplotLayer<SatDatum>({
      id: "sat-dot",
      data,
      billboard: true,
      radiusUnits: "pixels",
      getPosition: (d) => d.pos,
      getRadius: 1.5,
      radiusMinPixels: 1,
      radiusMaxPixels: 2.5,
      getFillColor: [180, 210, 255, Math.round(opacity * 180)] as Color,
      stroked: false,
    }),
    new TextLayer<SatDatum>({
      id: "sat-nearest-label",
      data: nearestDatum,
      getPosition: (d) => d.pos,
      getText: (d) => `${d.name}\n~${latencyMs} ms`,
      getSize: 11,
      sizeUnits: "pixels",
      getColor: [200, 230, 255, Math.round(opacity * 255)] as Color,
      billboard: true,
      getPixelOffset: [0, -(iconSize / 2 + 14)],
      getTextAnchor: "middle",
      getAlignmentBaseline: "bottom",
      fontFamily: "system-ui, sans-serif",
      fontWeight: 600,
      characterSet: "auto",
      background: true,
      getBackgroundColor: [8, 14, 26, Math.round(opacity * 210)] as Color,
      backgroundPadding: [5, 3, 5, 3],
      lineHeight: 1.35,
      parameters: { depthCompare: "always" as const },
    }),
  ];
}

export function DeckScene({
  layers,
  directives = EMPTY_DIRECTIVES,
  cameraCommand = null,
  referencedSiteIds = EMPTY_REF_IDS,
  onPickMast,
}: {
  layers: LayerVis;
  directives?: AgentMapState;
  cameraCommand?: CameraCommand | null;
  /** Mast ids the operator has referenced in the chat composer (drawn with a ring). */
  referencedSiteIds?: string[];
  /** Called with a mast id when the operator clicks an antenna on the map. */
  onPickMast?: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The map is built once in an effect that never re-runs; the animate loop reads the
  // latest layer states through this ref so toggles take effect without remounting the map.
  // Synced from props in its own effect (refs must not be written during render).
  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  // Agent-driven map highlights (map_action directives) — same ref pattern as layers so the
  // animate loop picks up new directives without rebuilding the map.
  const directivesRef = useRef(directives);
  useEffect(() => {
    directivesRef.current = directives;
  }, [directives]);

  // Referenced masts + the click callback follow the same ref pattern: the map is built once,
  // so the animate loop reads the latest set/callback through these refs without remounting.
  const referencedRef = useRef<Set<string>>(new Set(referencedSiteIds));
  useEffect(() => {
    referencedRef.current = new Set(referencedSiteIds);
  }, [referencedSiteIds]);
  const onPickMastRef = useRef(onPickMast);
  useEffect(() => {
    onPickMastRef.current = onPickMast;
  }, [onPickMast]);

  // The live MapLibre map, exposed so the camera/focus effects can drive it (the build
  // effect below is the only writer).
  const mapRef = useRef<maplibregl.Map | null>(null);

  // London coverage centroid (set once the bounds load) so the "flyToLondon" camera
  // command can return to the coverage view from the globe.
  const cLngRef = useRef(LONDON_LON);
  const cLatRef = useRef(LONDON_LAT);

  // Per-satellite position tracks, merged from each /api/starlink refresh; the animate
  // loop extrapolates them forward every frame (see interpolatedPositions).
  const satTracksRef = useRef<Map<string, SatTrack>>(new Map());

  // Timestamp set when "flyToGlobe" is pressed; lets the animate loop fade satellites in
  // immediately (rather than waiting for zoom to drop below 7) so they don't pop in.
  const flyToGlobeAtRef = useRef<number | null>(null);

  // Place labels, sourced from the canonical gazetteer on mount (see toLabelLandmarks); the
  // hardcoded LANDMARKS array is the fallback. declutterLabels reads this ref.
  const landmarksRef = useRef<Landmark[]>(LANDMARKS);

  // Agent fly-to: when a directive carries a `focus` (bumped nonce), fit its bbox or fly to
  // its centre. Keyed on the nonce so the same target re-fires; guarded until the map exists.
  useEffect(() => {
    const f = directives.focus;
    const map = mapRef.current;
    if (!f || !map) return;
    if (f.bbox) {
      map.fitBounds(
        [
          [f.bbox[0], f.bbox[1]],
          [f.bbox[2], f.bbox[3]],
        ],
        { padding: 96, duration: 1300, pitch: f.pitch ?? 45, maxZoom: 16.5 },
      );
    } else if (f.center) {
      map.flyTo({
        center: f.center,
        zoom: f.zoom ?? 15,
        pitch: f.pitch ?? 50,
        duration: 1300,
        essential: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directives.focus?.nonce]);

  // Camera command bus (left-rail buttons / agent): one-shot intents keyed on nonce.
  useEffect(() => {
    const map = mapRef.current;
    if (!cameraCommand || !map) return;
    switch (cameraCommand.type) {
      case "zoomIn":
        map.zoomIn();
        break;
      case "zoomOut":
        map.zoomOut();
        break;
      case "reset":
        map.easeTo({ pitch: 50, bearing: 0, duration: 700 });
        break;
      case "tilt2d":
        map.easeTo({ pitch: 0, duration: 600 });
        break;
      case "tilt3d":
        map.easeTo({ pitch: 55, duration: 600 });
        break;
      // Starlink view toggle: dive into the London coverage twin, or pull out to the
      // UK framing where the live constellation renders (satellites fade in as you zoom out).
      case "flyToLondon":
        flyToGlobeAtRef.current = null;
        map.flyTo({
          center: [cLngRef.current, cLatRef.current],
          zoom: 12.6,
          pitch: 50,
          bearing: 0,
          duration: 2800,
          essential: true,
        });
        break;
      case "flyToGlobe":
        flyToGlobeAtRef.current = Date.now();
        // Pull out to frame the whole UK (not the globe) so the live Starlink
        // constellation is seen drifting over Britain rather than the world.
        map.flyTo({
          center: [-2.6, 54.7],
          zoom: 4.7,
          pitch: 0,
          bearing: 0,
          duration: 2600,
          essential: true,
        });
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraCommand?.nonce]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let map: maplibregl.Map | null = null;
    let overlay: MapboxOverlay | null = null;
    let raf = 0;
    let cancelled = false;
    let satInterval = 0;

    (async () => {
      const bounds = (await fetchJSON(`${DATA}/coverage_bounds.json`)) as Bounds;
      if (cancelled) return;
      const cLng = (bounds.west + bounds.east) / 2;
      const cLat = (bounds.south + bounds.north) / 2;
      // Expose the coverage centroid to the camera bus so "flyToLondon" returns here.
      cLngRef.current = cLng;
      cLatRef.current = cLat;

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
      mapRef.current = map;

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
      const [buildings, raysFC, mastsFC, newFC, holesFC, emergency, gazetteer] =
        await Promise.all([
          fetchJSON(`${DATA}/buildings.geojson`) as Promise<GeoJSON>,
          fetchJSON(`${DATA}/paths.geojson`) as Promise<FC<RayFeature>>,
          fetchJSON(`${DATA}/masts.geojson`).catch(() => null) as Promise<FC<MastFeature> | null>,
          fetchJSON(`${DATA}/new_masts.geojson`).catch(() => null) as Promise<FC<MastFeature> | null>,
          fetchJSON(`${DATA}/hotspots.geojson`).catch(() => null) as Promise<HoleFC | null>,
          fetchJSON(`/api/emergency-services`).catch(() => null) as Promise<EmergencyPayload | null>,
          // Canonical place gazetteer — the same file the agent's knowledge graph reads.
          fetchJSON(`/geo/landmarks.json`).catch(() => null),
        ]);
      if (cancelled) return;
      landmarksRef.current = toLabelLandmarks(gazetteer);

      const data: SceneData = {
        buildings,
        trips: toTrips(raysFC),
        masts: toMasts(mastsFC, bounds, false),
        newMasts: toMasts(newFC, bounds, true),
        // Tags matched footprints in `buildings` in place, so build this before the layers.
        markers: matchServiceBuildings(buildings, emergency, bounds),
        holes: toHoles(holesFC),
        bounds,
      };

      // Static layers are rebuilt only when a layer toggle/opacity changes (tracked by
      // staticSig); the rays, mast beacon dots and service pins/names rebuild every frame
      // (they animate or track zoom) and read their visibility straight from layersRef.
      let staticLayers = buildStaticLayers(data, layersRef.current);
      let lastSig = staticSig(layersRef.current);

      // The decluttered place-label set is recomputed only when the viewport actually moves
      // (zoom/pan/rotate), then reused across frames so the per-frame rebuild hands deck.gl a
      // stable `data` array and it skips re-tessellating the text.
      let shownLabels: Landmark[] = declutterLabels(map!, landmarksRef.current);
      let lastLabelView = "";
      const labelViewKey = () => {
        const c = map!.getCenter();
        return `${map!.getZoom().toFixed(2)}|${c.lng.toFixed(4)}|${c.lat.toFixed(4)}|${map!.getBearing().toFixed(1)}|${map!.getPitch().toFixed(1)}`;
      };

      // Starlink: fetch live positions now, then refresh every 15 s. Each batch merges into
      // satTracksRef so the animate loop can extrapolate smoothly between refreshes.
      const refreshSats = () =>
        fetch("/api/starlink")
          .then((r) => r.json())
          .then((j: { satellites: SatellitePosition[] }) => {
            if (!cancelled) updateSatTracks(satTracksRef.current, j.satellites, Date.now());
          })
          .catch(() => {});
      void refreshSats();
      satInterval = window.setInterval(refreshSats, 15_000);

      // Click a satellite → fly the camera to its current ground-track position (kept at a
      // zoom where satellites stay visible, so the clicked one doesn't vanish on arrival).
      const onClickSat = (sat: SatellitePosition) => {
        map?.flyTo({
          center: [sat.lon, sat.lat],
          zoom: 5,
          pitch: 15,
          bearing: 0,
          duration: 2200,
          essential: true,
        });
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
          shownLabels = declutterLabels(map!, landmarksRef.current);
          lastLabelView = vk;
        }
        // Starlink constellation: full-bright at the UK framing (zoom ≤5), fading out as you
        // dive toward London (gone by zoom 8) so the dense city view stays uncluttered.
        let satOpacity = Math.max(0, Math.min(1, (8 - zoom) / 3));
        // If flyToGlobe was just pressed, fade satellites in immediately so they don't pop —
        // blend with the zoom-based opacity and take whichever is higher, until the zoom-out
        // settles at the UK framing (≤5.5) and the zoom-based curve takes over.
        if (flyToGlobeAtRef.current !== null) {
          const elapsed = Date.now() - flyToGlobeAtRef.current;
          const fadeIn = Math.min(1, elapsed / 1400);
          satOpacity = Math.max(satOpacity, fadeIn);
          if (zoom <= 5.5) flyToGlobeAtRef.current = null;
        }
        const sats = satOpacity > 0 ? interpolatedPositions(satTracksRef.current, Date.now()) : [];
        const refPulse = 0.5 + 0.5 * Math.sin(time * 0.06);
        overlay.setProps({
          layers: [
            ...staticLayers,
            buildRaysLayer(data.trips, time, zoom, L.rays),
            // Ring referenced masts behind the beacon dots so the selection reads on the map.
            buildMastRefRings(data.masts, referencedRef.current, scale, refPulse),
            buildMastDots("masts", data.masts, MAST_DOT_EE, scale, L.masts),
            buildMastDots("newmasts", data.newMasts, MAST_DOT_NEW, scale, L.proposed),
            // Invisible click targets on top of the EE beacons — only when masts are visible.
            ...(L.masts.visible
              ? [buildMastHits(data.masts, scale, (id) => onPickMastRef.current?.(id))]
              : []),
            buildServiceIcons(data.markers, scale, L.services),
            buildServiceLabels(data.markers, nearEnough, L.services, L.labels),
            // Agent-driven highlights (dead zones / COW / located buildings) over the scene
            // but under the place labels, pulsing; present only when the agent sets them.
            ...buildDirectiveLayers(directivesRef.current, time),
            // Place labels last so they sit on top; deconflicted CPU-side per viewport.
            ...buildLabelLayers(shownLabels, L.labels),
            // Starlink satellites on top of everything (globe view only).
            ...buildSatelliteLayers(sats, satOpacity, zoom, onClickSat),
          ],
        });
        raf = requestAnimationFrame(animate);
      };
      animate();
    })().catch((e) => console.error("[DeckScene]", e));

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearInterval(satInterval);
      if (overlay) overlay.finalize();
      if (map) map.remove();
      mapRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0 h-full w-full" />;
}

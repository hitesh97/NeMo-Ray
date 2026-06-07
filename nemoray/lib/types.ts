/**
 * NeMo-Ray data contract.
 *
 * This is the seam between the UI and the DGX-Spark backend. Components import
 * ONLY from here (and `lib/api/*`) — never from `lib/mock/*` or raw backend
 * shapes. The map's two implementations (placeholder + Cesium) both satisfy
 * {@link MapSurfaceProps}.
 */

// ── primitives ──────────────────────────────────────────────────────────────
export type LngLat = [number, number];
/** [minLng, minLat, maxLng, maxLat] */
export type BBox = [number, number, number, number];
export type RGB = [number, number, number];
/** Normalised [0,1] position for the placeholder map (0,0 = top-left/NW). */
export interface Norm {
  x: number;
  y: number;
}

// ── network / sites ─────────────────────────────────────────────────────────
export type SiteId = string;
export type Operator = "EE" | "ESN";
export type SiteStatus = "active" | "deactivated" | "failover";

export interface Site {
  id: SiteId;
  name: string;
  /** Real-world position (used by the Cesium map). */
  position: LngLat;
  /** Normalised position for the placeholder map. Derived from `position`. */
  placement: Norm;
  operator: Operator;
  tech: "LTE";
  band: string;
  heightM: number;
  azimuths: number[];
  txPowerDbm: number;
  coverageRadiusM: number;
  status: SiteStatus;
  /** Site this one back-hauls to (for the arc/backhaul layer). */
  backhaulTargetId?: SiteId;
  /** Subscribers currently served — drives load/congestion. */
  load: number;
}

// ── coverage / dead zones ───────────────────────────────────────────────────
/**
 * Discrete signal bands. Retained for the dormant colour ramp in
 * `lib/geo/color.ts` (`LEVEL_RGB`, `mbpsToLevel`); the coverage heatmap that
 * consumed it has been removed.
 */
export type CoverageLevel =
  | "critical"
  | "low"
  | "medium"
  | "good"
  | "excellent";

export interface DeadZone {
  id: string;
  /** Normalised centre + radius (placeholder). */
  center: Norm;
  radius: number;
  /** Real-world centroid (Cesium). */
  centroid: LngLat;
  severity: "minor" | "major" | "critical";
  causeSiteId?: SiteId;
}

export type CoverageStatus = "idle" | "computing" | "ready" | "error";

// ── scenarios + timeline ────────────────────────────────────────────────────
export type ScenarioId =
  | "live"
  | "high-demand"
  | "major-event"
  | "infrastructure-loss"
  | "cyber-attack"
  | "power-outage";

export type EventKind =
  | "alert"
  | "failover"
  | "congestion"
  | "optimisation"
  | "agent"
  | "info";

export interface EventMarker {
  id: string;
  tMs: number;
  kind: EventKind;
  label: string;
  severity?: "info" | "warning" | "critical";
  siteId?: SiteId;
}

export interface Scenario {
  id: ScenarioId;
  label: string;
  description: string;
  /** Sites that begin deactivated in this scenario. */
  seedDeactivated: SiteId[];
  events: EventMarker[];
  /** Timeline span in ms. */
  durationMs: number;
  synthetic: boolean;
}

export type TimelineMode = "live" | "playback";

// ── agent + tools ───────────────────────────────────────────────────────────
export type AgentRole = "agent" | "operator" | "system";

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  streaming?: boolean;
  /** Optional collapsed reasoning trace. */
  reasoning?: string;
  toolCallIds?: string[];
  createdAt: number;
}

// Mirrors the agent's tool registry (agent/nemoray_modelling/tools.py TOOL_LABELS).
export type ToolName =
  | "run_sionna_coverage"
  | "run_cuopt"
  | "validate_site"
  | "simulate_outage"
  | "move_mast"
  | "deploy_cow"
  | "check_starlink";

export type ToolStatus = "queued" | "running" | "success" | "error";

export interface ToolCall {
  id: string;
  name: ToolName;
  label: string;
  status: ToolStatus;
  args?: Record<string, unknown>;
  result?: string;
  progress?: number;
  startedAt?: number;
  finishedAt?: number;
  /**
   * Structured observation from the tool (COW position, affected buildings, dead
   * zones, satellite…), sent by the agent on the success `tool_update`. Kept so the
   * map can later draw the outcome; the tool card itself renders `result`.
   */
  data?: Record<string, unknown>;
}

/** SSE wire protocol for `/api/agent`. Identical for mock and real. */
export type AgentStreamEvent =
  | { type: "message_start"; id: string; role: AgentRole }
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_update"; id: string; patch: Partial<ToolCall> }
  | { type: "message_end"; id: string }
  | { type: "error"; message: string };

// ── cuOpt optimiser ─────────────────────────────────────────────────────────
export type ProposalStatus =
  | "proposed"
  | "validating"
  | "accepted"
  | "rejected";

export interface Proposal {
  id: string;
  label: string;
  position: LngLat;
  placement: Norm;
  coverageGainPct: number;
  estCostGbp: number;
  rationale: string;
  status: ProposalStatus;
  validation?: {
    source: "LiDAR" | "StreetView";
    verdict: "pass" | "fail";
    reason: string;
  };
}

// ── map surface contract ────────────────────────────────────────────────────
// One id per controllable group on the deck.gl surface (DeckScene). Each maps to one
// or more deck layer ids — see MAP_LAYER_IDS in components/map/DeckScene.tsx.
export type LayerId =
  | "buildings"
  | "rays"
  | "masts"
  | "proposed"
  | "deadzone"
  | "services"
  | "labels";

export interface LayerState {
  visible: boolean;
  opacity: number;
}

export interface MapViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

// ── pipeline telemetry (public/raytracing/summary.json) ─────────────────────
/**
 * The real run summary the Python pipeline writes to
 * `nemoray/public/raytracing/summary.json` on every solve (see `src/export.py`
 * `export_all`). Mirrors that file's shape — coverage figures plus a GPU/RT
 * `performance` block. All `performance` fields are optional so the HUD degrades
 * gracefully on an older artifact that lacks them.
 */
export interface CoverageTelemetry {
  /** EE masts inside the simulated bbox. */
  sites_total: number;
  /** OSM building footprints modelled. */
  buildings: number;
  /** Radio-map cells solved across all tiles. */
  simulated_cells: number;
  /** % of cells above the served threshold. */
  served_pct: number;
  /** Low-coverage polygons (coverage holes / dead zones). */
  low_coverage_polys: number;
  /** Total ray-path polylines exported. */
  ray_paths: number;
  /** Masts that emitted at least one exported ray. */
  masts_emitting_rays: number;
  /** Geographic extent actually rendered (WGS84). */
  coverage_bounds: { west: number; south: number; east: number; north: number };
  performance?: {
    device?: string;
    backend?: string;
    peak_gpu_util_pct?: number;
    mean_gpu_util_pct?: number;
    /** Peak per-process GPU memory during the RT solve, MiB. */
    peak_gpu_mem_mib?: number;
    samples?: number;
    coverage_solve?: {
      tiles_solved?: number;
      transmitters?: number;
      mean_ms?: number;
      p50_ms?: number;
      max_ms?: number;
    };
    radio_map_cells?: number;
    ray_trace?: { count?: number; total_s?: number; rays_per_s?: number };
    mosaic_s?: number;
    wall_time_s?: number;
  };
}

/**
 * The ONE contract every map implementation satisfies. `MapPlaceholder` and
 * `CesiumScene` both accept exactly this — swapping is a single env flag
 * (`NEXT_PUBLIC_MAP_IMPL`).
 */
export interface MapSurfaceProps {
  sites: Site[];
  deadZones: DeadZone[];
  selectedSiteId: SiteId | null;
  hoveredSiteId: SiteId | null;
  deactivatedSiteIds: SiteId[];
  proposals: Proposal[];
  layers: Record<LayerId, LayerState>;
  coverageStatus: CoverageStatus;
  viewState?: MapViewState;
  /** One-shot camera intent (nonce-deduped) dispatched from HUD chrome. */
  cameraCommand?: CameraCommand | null;
  onSelectSite(id: SiteId | null): void;
  onHoverSite(id: SiteId | null): void;
  onViewStateChange?(v: MapViewState): void;
}

// ── camera command bus ──────────────────────────────────────────────────────
/** Camera intents a surface can honour. Dispatched via the store's nonce bus. */
export type CameraCommandType = "zoomIn" | "zoomOut" | "reset" | "tilt2d" | "tilt3d";

/** A one-shot camera intent. `nonce` makes repeats of the same type distinct. */
export interface CameraCommand {
  type: CameraCommandType;
  nonce: number;
}

// ── workspaces ──────────────────────────────────────────────────────────────
export type Workspace =
  | "mission"
  | "coverage"
  | "optimiser"
  | "agent"
  | "scenarios";

/** Which panel the left rail is showing (context side). */
export type LeftRailTab = "network" | "scenarios";
/** Which panel the right rail is showing (action side). */
export type RightRailTab = "chat" | "cuopt" | "stats";

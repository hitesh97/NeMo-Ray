import { create } from "zustand";

import { delay } from "@/lib/api/client";
import { type VadState } from "@/hooks/useVoice";
import type { AgentRequest } from "@/lib/api/agent";
import { lngLatToNorm } from "@/lib/geo/bbox";
import { DEFAULT_LAYERS } from "@/lib/layers";
import { DEFAULT_SCENARIO, SCENARIOS, scenarioFromText } from "@/lib/scenarios";
import type {
  AgentMapState,
  AgentMessage,
  AgentStreamEvent,
  BBox,
  CameraCommand,
  CameraCommandType,
  LngLat,
  MapAction,
  CoverageStatus,
  CoverageTelemetry,
  DeadZone,
  LayerId,
  LayerState,
  LeftRailTab,
  NemotronTelemetry,
  Proposal,
  ProposalStatus,
  RestorationPlan,
  RightRailTab,
  Scenario,
  ScenarioId,
  Site,
  SiteId,
  ToolCall,
  Workspace,
} from "@/lib/types";

export interface PanelState {
  left: boolean;
  right: boolean;
  bottom: boolean;
}

interface NemoState {
  // ── scenario ──
  activeScenarioId: ScenarioId;
  scenarios: Record<ScenarioId, Scenario>;
  setScenario(id: ScenarioId): void;

  // ── network ──
  sites: Site[];
  sitesById: Record<SiteId, Site>;
  deactivatedSiteIds: SiteId[];
  selectedSiteId: SiteId | null;
  hoveredSiteId: SiteId | null;
  /** Masts the operator has clicked on the map to reference in the next chat prompt. */
  referencedSiteIds: SiteId[];
  deadZones: DeadZone[];
  coverageStatus: CoverageStatus;
  proposals: Proposal[];
  /** Real pipeline run summary (public/raytracing/summary.json); null until loaded. */
  telemetry: CoverageTelemetry | null;
  setTelemetry(t: CoverageTelemetry | null): void;
  selectSite(id: SiteId | null): void;
  hoverSite(id: SiteId | null): void;
  /** Add a clicked mast to the chat references, or remove it if already referenced. */
  toggleReferencedSite(id: SiteId): void;
  clearReferencedSites(): void;
  deactivateSite(id: SiteId): void;
  /** Take several masts offline at once (no per-site agent auto-run) — used by the chat takedown. */
  deactivateSites(ids: SiteId[]): void;
  reactivateSite(id: SiteId): void;
  toggleSite(id: SiteId): void;
  recomputeCoverage(): Promise<void>;
  setProposalStatus(id: string, status: ProposalStatus): void;

  // ── layers ──
  layers: Record<LayerId, LayerState>;
  toggleLayer(id: LayerId): void;
  setLayerOpacity(id: LayerId, opacity: number): void;

  // ── restoration (traffic-aware COW ETA for the active scenario's outage) ──
  /** Traffic-aware restoration estimate for the active scenario's outage (null when nominal). */
  restoration: RestorationPlan | null;
  /** Set/clear the restoration plan (computed by useScenarioTimeline on scenario change). */
  setRestoration(plan: RestorationPlan | null): void;

  // ── agent ──
  messages: AgentMessage[];
  toolCalls: ToolCall[];
  streaming: boolean;
  activeMessageId: string | null;
  agentTrigger: { req: AgentRequest; nonce: number } | null;
  addOperatorMessage(text: string): void;
  requestAgentRun(req: AgentRequest): void;
  clearAgentTrigger(): void;
  applyStreamEvent(e: AgentStreamEvent): void;
  resetConversation(): void;

  // ── nemotron inference telemetry (Stats board) ──
  /** Live Nemotron VRAM/util/device + output-token-rate; null fields until measured. */
  nemotron: NemotronTelemetry;
  /** Merge a GPU sample polled from the Spark backend (`/api/agent/gpu`). */
  setNemotronGpu(p: Partial<NemotronTelemetry>): void;

  // ── agent-driven map highlights (map_action directives) ──
  agentMap: AgentMapState;
  applyMapAction(a: MapAction): void;
  clearAgentMap(): void;
  /**
   * Bumped whenever a coverage-mutating agent tool succeeds (simulate_outage, move_mast,
   * deploy_cow, run_cuopt, run_sionna_coverage) — the twin has rewritten the ray-tracing
   * artifacts (paths/new_masts/hotspots/coverage), so the map re-fetches them.
   */
  artifactsNonce: number;

  // ── voice ──
  voiceAvailable: boolean;
  voiceRecording: boolean;
  voiceTranscribing: boolean;
  voiceSpeaking: boolean;
  voiceVadState: VadState;
  setVoiceAvailable(v: boolean): void;
  setVoiceRecording(v: boolean): void;
  setVoiceTranscribing(v: boolean): void;
  setVoiceSpeaking(v: boolean): void;
  setVoiceVadState(s: VadState): void;

  // ── camera ──
  cameraCommand: CameraCommand | null;
  requestCamera(type: CameraCommandType): void;

  // ── ui ──
  activeWorkspace: Workspace;
  leftRailTab: LeftRailTab;
  rightRailTab: RightRailTab;
  panels: PanelState;
  mapFocus: boolean;
  setWorkspace(w: Workspace): void;
  setLeftRailTab(tab: LeftRailTab): void;
  setRightRailTab(tab: RightRailTab): void;
  togglePanel(side: keyof PanelState): void;
  setPanel(side: keyof PanelState, collapsed: boolean): void;
  setPanels(p: PanelState): void;
  toggleMapFocus(): void;
}

let agentNonce = 0;
let cameraNonce = 0;

// ── nemotron output-token-rate measurement ──
// We measure the agent's generation throughput client-side from the SSE token stream
// (one `token` frame ≈ one model token). These module-scoped counters track the active
// agent generation so applyStreamEvent can derive a live tok/s without storing scratch
// state in the store. `runIsAgent` gates them so a `system` message (e.g. the no-backend
// notice) doesn't pollute the figure.
let runStartMs = 0;
let runTokens = 0;
let runIsAgent = false;

const EMPTY_NEMOTRON: NemotronTelemetry = {
  device: null,
  model: null,
  vramUsedMib: null,
  vramTotalMib: null,
  gpuUtilPct: null,
  outputTokPerSec: null,
  peakTokPerSec: null,
  lastOutputTokens: null,
};

// ── agent-driven map highlights ──
/** Tools whose success means the twin rewrote the on-disk ray-tracing artifacts. */
const COVERAGE_TOOLS = new Set([
  "simulate_outage",
  "move_mast",
  "deploy_cow",
  "run_cuopt",
  "run_sionna_coverage",
  "clear_proposals",
]);

const EMPTY_AGENT_MAP: AgentMapState = {
  zones: [],
  markers: [],
  cow: null,
  station: null,
  route: null,
  focus: null,
};

/**
 * Pure reducer: fold one {@link MapAction} directive into the accumulated overlay state.
 * Each op replaces its own slice (zones / markers / cow set); a `focus` bumps a nonce so
 * DeckScene re-fires the camera even for the same target. `clear` keeps the last focus so
 * the camera doesn't snap back when highlights are wiped.
 */
function reduceAgentMap(prev: AgentMapState, a: MapAction): AgentMapState {
  const bumpFocus = (f?: { center?: LngLat; bbox?: BBox; zoom?: number; pitch?: number }) =>
    f ? { focus: { ...f, nonce: (prev.focus?.nonce ?? 0) + 1 } } : null;
  switch (a.op) {
    case "clear":
      return { ...EMPTY_AGENT_MAP, focus: prev.focus };
    case "zones":
      return { ...prev, zones: a.zones, ...(bumpFocus(a.focus) ?? {}) };
    case "markers":
      return { ...prev, markers: a.markers, ...(bumpFocus(a.focus) ?? {}) };
    case "cow":
      return {
        ...prev,
        cow: a.cow,
        station: a.station ?? null,
        route: a.route ?? null,
        ...(bumpFocus(a.focus) ?? {}),
      };
    case "focus":
      return { ...prev, focus: { ...a.focus, nonce: (prev.focus?.nonce ?? 0) + 1 } };
    default:
      return prev;
  }
}

// Map the run_cuopt tool's observation (its full candidate list) into Proposal cards for the
// Optimiser panel — so the panel shows the WHOLE optimiser plan (e.g. 53 masts), not nothing.
// Returns null if the observation carries no candidates (then the panel is left unchanged).
function proposalsFromCuopt(data: Record<string, unknown> | undefined): Proposal[] | null {
  const cands = data?.candidates;
  if (!Array.isArray(cands) || cands.length === 0) return null;
  return cands.map((raw, i) => {
    const c = raw as Record<string, unknown>;
    const lng = Number(c.lng);
    const lat = Number(c.lat);
    const position: LngLat = [lng, lat];
    const covers = c.covers_holes;
    return {
      id: String(c.candidate_id ?? `cand-${i}`),
      label: String(c.label ?? "Proposed mast"),
      position,
      placement: lngLatToNorm(position),
      // The agent sends coverage gain as a fraction (0.31); the card renders a percent.
      coverageGainPct: Number(c.coverage_gain_pct ?? 0) * 100,
      estCostGbp: Number(c.est_cost_gbp ?? 0),
      rationale:
        covers != null
          ? `cuOpt-proposed site — closes ${covers} dead-zone cell(s).`
          : "cuOpt-proposed mast site.",
      status: "proposed" as ProposalStatus,
    };
  });
}

export const useNemoStore = create<NemoState>((set, get) => ({
  // ── scenario ──
  activeScenarioId: DEFAULT_SCENARIO,
  scenarios: SCENARIOS,
  setScenario: (id) => {
    const scenario = get().scenarios[id];
    set({
      activeScenarioId: id,
      deactivatedSiteIds: scenario.seedDeactivated,
      selectedSiteId: null,
      // Cleared here; useScenarioTimeline recomputes it for the new scenario's outage.
      restoration: null,
    });
  },

  // ── network ──
  // Empty until wired to a real feed — the demo seed data was removed.
  sites: [],
  sitesById: {},
  deactivatedSiteIds: [],
  selectedSiteId: null,
  hoveredSiteId: null,
  referencedSiteIds: [],
  deadZones: [],
  coverageStatus: "idle",
  proposals: [],
  telemetry: null,
  setTelemetry: (t) => set({ telemetry: t }),

  selectSite: (id) => set({ selectedSiteId: id }),
  hoverSite: (id) => set({ hoveredSiteId: id }),

  toggleReferencedSite: (id) =>
    set((st) => ({
      referencedSiteIds: st.referencedSiteIds.includes(id)
        ? st.referencedSiteIds.filter((s) => s !== id)
        : [...st.referencedSiteIds, id],
    })),
  clearReferencedSites: () => set({ referencedSiteIds: [] }),

  deactivateSite: (id) => {
    const { deactivatedSiteIds, sitesById } = get();
    if (deactivatedSiteIds.includes(id)) return;
    set((st) => ({
      deactivatedSiteIds: [...st.deactivatedSiteIds, id],
      sites: st.sites.map((s) => (s.id === id ? { ...s, status: "deactivated" } : s)),
    }));
    void get().recomputeCoverage();
    const site = sitesById[id];
    get().requestAgentRun({
      trigger: { kind: "site_down", siteId: id, siteName: site?.name ?? id },
    });
  },

  reactivateSite: (id) => {
    set((st) => ({
      deactivatedSiteIds: st.deactivatedSiteIds.filter((x) => x !== id),
      sites: st.sites.map((s) => (s.id === id ? { ...s, status: "active" } : s)),
    }));
    void get().recomputeCoverage();
  },

  deactivateSites: (ids) => {
    const add = ids.filter((id) => !get().deactivatedSiteIds.includes(id));
    if (add.length === 0) return;
    const down = new Set(add);
    set((st) => ({
      deactivatedSiteIds: [...st.deactivatedSiteIds, ...add],
      sites: st.sites.map((s) => (down.has(s.id) ? { ...s, status: "deactivated" } : s)),
    }));
    void get().recomputeCoverage();
  },

  toggleSite: (id) =>
    get().deactivatedSiteIds.includes(id)
      ? get().reactivateSite(id)
      : get().deactivateSite(id),

  recomputeCoverage: async () => {
    // The mock coverage model was removed; coverage now comes from a real feed.
    // Until that's wired, this just flips the status without deriving dead zones.
    set({ coverageStatus: "computing" });
    try {
      await delay(280);
      set({ coverageStatus: "ready" });
    } catch {
      set({ coverageStatus: "error" });
    }
  },

  setProposalStatus: (id, status) =>
    set((st) => ({
      proposals: st.proposals.map((p) => (p.id === id ? { ...p, status } : p)),
    })),

  // ── layers ──
  layers: DEFAULT_LAYERS,
  toggleLayer: (id) =>
    set((st) => ({
      layers: { ...st.layers, [id]: { ...st.layers[id], visible: !st.layers[id].visible } },
    })),
  setLayerOpacity: (id, opacity) =>
    set((st) => ({
      layers: { ...st.layers, [id]: { ...st.layers[id], opacity } },
    })),

  // ── restoration (traffic-aware COW ETA for the active scenario's outage) ──
  restoration: null,
  setRestoration: (plan) => set({ restoration: plan }),

  // ── agent ──
  messages: [],
  toolCalls: [],
  streaming: false,
  activeMessageId: null,
  agentTrigger: null,
  addOperatorMessage: (text) =>
    set((st) => ({
      messages: [
        ...st.messages,
        { id: `op-${Date.now()}`, role: "operator", content: text, createdAt: Date.now() },
      ],
    })),
  requestAgentRun: (req) => {
    agentNonce += 1;
    // If the operator's prompt names a scenario ("run the power outage scenario"), flip the HUD
    // scenario switch FIRST — so the map, timeline and outage context all reflect it before the
    // run is assembled below (the agent then drives the end-to-end response).
    if (req.prompt) {
      const sid = scenarioFromText(req.prompt);
      if (sid && sid !== get().activeScenarioId) get().setScenario(sid);
    }
    // Enrich the run with the context the backend agent needs: prior conversation
    // (so Nemotron can track back) and the masts the operator has selected on the
    // map (outage / move targets). `addOperatorMessage` runs before this on the
    // prompt path, so drop the trailing operator turn that duplicates req.prompt —
    // the backend already receives it as the event text.
    const st = get();
    const history = st.messages
      .filter((m) => (m.role === "operator" || m.role === "agent") && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));
    if (
      req.prompt &&
      history.length > 0 &&
      history[history.length - 1].role === "operator" &&
      history[history.length - 1].content === req.prompt
    ) {
      history.pop();
    }
    // The action targets, in priority order: the masts the operator clicked on the map and
    // referenced in this chat prompt ("take it down"), else a single hand-selected site, else
    // the active scenario's pre-rendered outage — so "simulate the selected masts" acts on the
    // scenario even with nothing referenced. The scenario id rides along too as the backend's
    // fallback selector. We only consume the chat references on the prompt path when the caller
    // didn't pass explicit ids, so unrelated auto-triggers (site_down narration, the cuOpt
    // button) don't steal the operator's staged chips.
    const activeScenario = st.scenarios[st.activeScenarioId];
    const usingReferenced =
      !!req.prompt && req.selectedSiteIds === undefined && st.referencedSiteIds.length > 0;
    const selectedSiteIds = usingReferenced
      ? st.referencedSiteIds
      : st.selectedSiteId
        ? [st.selectedSiteId]
        : activeScenario.outage?.siteIds;
    const enriched: AgentRequest = {
      ...req,
      history: history.length > 0 ? history : undefined,
      selectedSiteIds: req.selectedSiteIds ?? selectedSiteIds,
      scenario: req.scenario ?? st.activeScenarioId,
    };
    // A fresh run starts with a clean map — last turn's highlights are wiped (the new
    // run's tools repaint as they go). Keeps the overlay in sync with the conversation.
    set({ agentTrigger: { req: enriched, nonce: agentNonce }, agentMap: EMPTY_AGENT_MAP });
    // Once consumed, the chips clear — the references belonged to this prompt.
    if (usingReferenced) set({ referencedSiteIds: [] });
  },
  clearAgentTrigger: () => set({ agentTrigger: null }),
  applyStreamEvent: (e) =>
    set((st) => {
      switch (e.type) {
        case "message_start":
          // Begin measuring output throughput for an agent generation (system notices
          // don't count). Counters live in module scope; the figure lands in `nemotron`.
          runIsAgent = e.role === "agent";
          if (runIsAgent) {
            runStartMs = Date.now();
            runTokens = 0;
          }
          return {
            streaming: true,
            activeMessageId: e.id,
            messages: [
              ...st.messages,
              { id: e.id, role: e.role, content: "", streaming: true, createdAt: Date.now() },
            ],
          };
        case "token": {
          const messages = st.messages.map((m) =>
            m.id === st.activeMessageId ? { ...m, content: m.content + e.text } : m,
          );
          if (!runIsAgent) return { messages };
          // One token frame ≈ one model token. Derive a live tok/s and track the peak.
          runTokens += 1;
          const elapsedS = (Date.now() - runStartMs) / 1000;
          const rate = elapsedS > 0 ? runTokens / elapsedS : null;
          return {
            messages,
            nemotron: {
              ...st.nemotron,
              lastOutputTokens: runTokens,
              outputTokPerSec: rate,
              peakTokPerSec:
                rate !== null ? Math.max(rate, st.nemotron.peakTokPerSec ?? 0) : st.nemotron.peakTokPerSec,
            },
          };
        }
        case "reasoning":
          return {
            messages: st.messages.map((m) =>
              m.id === st.activeMessageId
                ? { ...m, reasoning: (m.reasoning ?? "") + e.text }
                : m,
            ),
          };
        case "tool_call":
          return {
            toolCalls: [...st.toolCalls, e.call],
            messages: st.messages.map((m) =>
              m.id === st.activeMessageId
                ? { ...m, toolCallIds: [...(m.toolCallIds ?? []), e.call.id] }
                : m,
            ),
          };
        case "tool_update": {
          const next: Partial<NemoState> = {
            toolCalls: st.toolCalls.map((t) => (t.id === e.id ? { ...t, ...e.patch } : t)),
          };
          // When cuOpt finishes, hydrate the Optimiser panel from its candidate list so the
          // panel shows the full proposed-mast plan instead of "No proposals".
          const tool = st.toolCalls.find((t) => t.id === e.id);
          if (tool?.name === "run_cuopt" && e.patch.data) {
            const proposals = proposalsFromCuopt(e.patch.data);
            if (proposals) next.proposals = proposals;
          }
          // Clearing the plan empties the Optimiser panel along with the map artifacts,
          // and resets the client-side outage state — the baseline restore brings every
          // mast back, so red beacons / hidden rays would contradict the map.
          if (tool?.name === "clear_proposals" && e.patch.status === "success") {
            next.proposals = [];
            next.deactivatedSiteIds = [];
          }
          // The simulation defines what is down NOW: mark exactly the masts the tool
          // disabled (scenario sets, typed ids, or clicked ids alike) so their beacons
          // burn red and their rays drop — regardless of how they were chosen.
          if (
            tool?.name === "simulate_outage" &&
            e.patch.status === "success" &&
            Array.isArray((e.patch.data as { disabled_cells?: unknown })?.disabled_cells)
          ) {
            next.deactivatedSiteIds = (
              (e.patch.data as { disabled_cells: unknown[] }).disabled_cells
            ).map(String);
          }
          // A relocated mast is disabled at its old position.
          if (tool?.name === "move_mast" && e.patch.status === "success") {
            const sid = (e.patch.data as { site_id?: unknown })?.site_id;
            if (typeof sid === "string" && !st.deactivatedSiteIds.includes(sid)) {
              next.deactivatedSiteIds = [...st.deactivatedSiteIds, sid];
            }
          }
          // A coverage-mutating tool just finished: the twin rewrote the artifacts
          // (paths/new_masts/hotspots/coverage.png), so nudge the map to re-fetch them.
          if (
            e.patch.status === "success" &&
            tool &&
            COVERAGE_TOOLS.has(tool.name)
          ) {
            next.artifactsNonce = st.artifactsNonce + 1;
          }
          return next;
        }
        case "map_action":
          // A tool (or the agent) drove the map — fold the directive into the overlay.
          return { agentMap: reduceAgentMap(st.agentMap, e.action) };
        case "message_end": {
          // Finalise the run's throughput from the full generation (total tokens / total
          // wall time) so the readout settles on an accurate figure once streaming stops.
          const finalize =
            runIsAgent && runTokens > 0 && runStartMs > 0
              ? (() => {
                  const elapsedS = (Date.now() - runStartMs) / 1000;
                  const rate = elapsedS > 0 ? runTokens / elapsedS : st.nemotron.outputTokPerSec;
                  return {
                    nemotron: {
                      ...st.nemotron,
                      lastOutputTokens: runTokens,
                      outputTokPerSec: rate,
                      peakTokPerSec:
                        rate !== null
                          ? Math.max(rate, st.nemotron.peakTokPerSec ?? 0)
                          : st.nemotron.peakTokPerSec,
                    },
                  };
                })()
              : {};
          runIsAgent = false;
          return {
            ...finalize,
            streaming: false,
            activeMessageId: null,
            messages: st.messages.map((m) => (m.id === e.id ? { ...m, streaming: false } : m)),
          };
        }
        case "error":
          return {
            streaming: false,
            activeMessageId: null,
            messages: [
              ...st.messages,
              { id: `err-${Date.now()}`, role: "system", content: e.message, createdAt: Date.now() },
            ],
          };
        default:
          return {};
      }
    }),
  resetConversation: () =>
    {
      // Everything back to the original state: conversation + overlay (client), the
      // outage/reference/proposal state (client), AND the simulation itself — the twin
      // restores its baseline snapshot, then the map re-fetches the artifacts.
      set({
        messages: [],
        toolCalls: [],
        streaming: false,
        activeMessageId: null,
        agentMap: EMPTY_AGENT_MAP,
        deactivatedSiteIds: [],
        referencedSiteIds: [],
        proposals: [],
      });
      void fetch("/api/agent/reset", { method: "POST" })
        .then(() => set((st) => ({ artifactsNonce: st.artifactsNonce + 1 })))
        .catch(() => {});
    },

  // ── nemotron inference telemetry ──
  nemotron: EMPTY_NEMOTRON,
  setNemotronGpu: (p) => set((st) => ({ nemotron: { ...st.nemotron, ...p } })),

  // ── agent-driven map highlights ──
  agentMap: EMPTY_AGENT_MAP,
  artifactsNonce: 0,
  applyMapAction: (a) => set((st) => ({ agentMap: reduceAgentMap(st.agentMap, a) })),
  clearAgentMap: () => set({ agentMap: EMPTY_AGENT_MAP }),

  // ── voice ──
  voiceAvailable: false,
  voiceRecording: false,
  voiceTranscribing: false,
  voiceSpeaking: false,
  voiceVadState: "idle" as VadState,
  setVoiceAvailable: (v) => set({ voiceAvailable: v }),
  setVoiceRecording: (v) => set({ voiceRecording: v }),
  setVoiceTranscribing: (v) => set({ voiceTranscribing: v }),
  setVoiceSpeaking: (v) => set({ voiceSpeaking: v }),
  setVoiceVadState: (s) => set({ voiceVadState: s }),

  // ── camera ──
  cameraCommand: null,
  requestCamera: (type) => {
    cameraNonce += 1;
    set({ cameraCommand: { type, nonce: cameraNonce } });
  },

  // ── ui ──
  activeWorkspace: "mission",
  leftRailTab: "network",
  rightRailTab: "chat",
  panels: { left: false, right: false, bottom: false },
  mapFocus: false,
  setWorkspace: (w) => set({ activeWorkspace: w }),
  setLeftRailTab: (tab) => set({ leftRailTab: tab }),
  setRightRailTab: (tab) => set({ rightRailTab: tab }),
  togglePanel: (side) =>
    set((st) => ({ panels: { ...st.panels, [side]: !st.panels[side] } })),
  setPanel: (side, collapsed) =>
    set((st) => ({ panels: { ...st.panels, [side]: collapsed } })),
  setPanels: (p) => set({ panels: p }),
  toggleMapFocus: () =>
    set((st) => {
      const next = !st.mapFocus;
      return {
        mapFocus: next,
        panels: next
          ? { left: true, right: true, bottom: true }
          : { left: false, right: false, bottom: false },
      };
    }),
}));

// ── convenience selector hooks ──
export const useSites = () => useNemoStore((s) => s.sites);
export const useTelemetry = () => useNemoStore((s) => s.telemetry);
export const useNemotron = () => useNemoStore((s) => s.nemotron);
export const useSelectedSite = () =>
  useNemoStore((s) => (s.selectedSiteId ? s.sitesById[s.selectedSiteId] : null));
export const usePanels = () => useNemoStore((s) => s.panels);
export const useLeftRailTab = () => useNemoStore((s) => s.leftRailTab);
export const useRightRailTab = () => useNemoStore((s) => s.rightRailTab);
export const useAgentMap = () => useNemoStore((s) => s.agentMap);

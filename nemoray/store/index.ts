import { create } from "zustand";

import { delay } from "@/lib/api/client";
import { type VadState } from "@/hooks/useVoice";
import type { AgentRequest } from "@/lib/api/agent";
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
  EventMarker,
  LayerId,
  LayerState,
  LeftRailTab,
  Proposal,
  ProposalStatus,
  RestorationPlan,
  RightRailTab,
  Scenario,
  ScenarioId,
  Site,
  SiteId,
  TimelineMode,
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
  deadZones: DeadZone[];
  coverageStatus: CoverageStatus;
  proposals: Proposal[];
  /** Real pipeline run summary (public/raytracing/summary.json); null until loaded. */
  telemetry: CoverageTelemetry | null;
  setTelemetry(t: CoverageTelemetry | null): void;
  selectSite(id: SiteId | null): void;
  hoverSite(id: SiteId | null): void;
  deactivateSite(id: SiteId): void;
  reactivateSite(id: SiteId): void;
  toggleSite(id: SiteId): void;
  recomputeCoverage(): Promise<void>;
  setProposalStatus(id: string, status: ProposalStatus): void;

  // ── layers ──
  layers: Record<LayerId, LayerState>;
  toggleLayer(id: LayerId): void;
  setLayerOpacity(id: LayerId, opacity: number): void;

  // ── timeline ──
  timelineMode: TimelineMode;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  speed: number;
  events: EventMarker[];
  /** Traffic-aware restoration estimate for the active scenario's outage (null when nominal). */
  restoration: RestorationPlan | null;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  setLive(): void;
  setSpeed(n: number): void;
  tick(dtMs: number): void;
  /** Replace the timeline + restoration plan (computed by useScenarioTimeline). */
  setTimeline(events: EventMarker[], durationMs: number, restoration: RestorationPlan | null): void;

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

  // ── agent-driven map highlights (map_action directives) ──
  agentMap: AgentMapState;
  applyMapAction(a: MapAction): void;
  clearAgentMap(): void;

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

// ── agent-driven map highlights ──
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
      events: scenario.events,
      durationMs: scenario.durationMs,
      positionMs: scenario.durationMs,
      timelineMode: "live",
      playing: false,
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
  deadZones: [],
  coverageStatus: "idle",
  proposals: [],
  telemetry: null,
  setTelemetry: (t) => set({ telemetry: t }),

  selectSite: (id) => set({ selectedSiteId: id }),
  hoverSite: (id) => set({ hoveredSiteId: id }),

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

  // ── timeline ──
  timelineMode: "live",
  positionMs: SCENARIOS[DEFAULT_SCENARIO].durationMs,
  durationMs: SCENARIOS[DEFAULT_SCENARIO].durationMs,
  playing: false,
  speed: 1,
  events: SCENARIOS[DEFAULT_SCENARIO].events,
  restoration: null,
  play: () => set({ playing: true, timelineMode: "playback" }),
  pause: () => set({ playing: false }),
  seek: (ms) =>
    set((st) => ({
      positionMs: Math.max(0, Math.min(st.durationMs, ms)),
      timelineMode: "playback",
    })),
  setLive: () => set((st) => ({ timelineMode: "live", playing: false, positionMs: st.durationMs })),
  setSpeed: (n) => set({ speed: n }),
  tick: (dtMs) =>
    set((st) => {
      if (!st.playing) return {};
      const next = st.positionMs + dtMs * st.speed;
      if (next >= st.durationMs) return { positionMs: st.durationMs, playing: false, timelineMode: "live" };
      return { positionMs: next };
    }),
  setTimeline: (events, durationMs, restoration) =>
    set({ events, durationMs, positionMs: durationMs, timelineMode: "live", playing: false, restoration }),

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
    // The action targets: the masts the operator clicked, else the active scenario's
    // pre-rendered outage — so "simulate the selected masts" acts on the scenario even with
    // nothing hand-selected (this is the frontend half of the old placeholder-loop fix). The
    // scenario id rides along too as the backend's fallback selector.
    const activeScenario = st.scenarios[st.activeScenarioId];
    const selectedSiteIds = st.selectedSiteId
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
  },
  clearAgentTrigger: () => set({ agentTrigger: null }),
  applyStreamEvent: (e) =>
    set((st) => {
      switch (e.type) {
        case "message_start":
          return {
            streaming: true,
            activeMessageId: e.id,
            messages: [
              ...st.messages,
              { id: e.id, role: e.role, content: "", streaming: true, createdAt: Date.now() },
            ],
          };
        case "token":
          return {
            messages: st.messages.map((m) =>
              m.id === st.activeMessageId ? { ...m, content: m.content + e.text } : m,
            ),
          };
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
        case "tool_update":
          return {
            toolCalls: st.toolCalls.map((t) => (t.id === e.id ? { ...t, ...e.patch } : t)),
          };
        case "map_action":
          // A tool (or the agent) drove the map — fold the directive into the overlay.
          return { agentMap: reduceAgentMap(st.agentMap, e.action) };
        case "message_end":
          return {
            streaming: false,
            activeMessageId: null,
            messages: st.messages.map((m) => (m.id === e.id ? { ...m, streaming: false } : m)),
          };
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
    set({ messages: [], toolCalls: [], streaming: false, activeMessageId: null, agentMap: EMPTY_AGENT_MAP }),

  // ── agent-driven map highlights ──
  agentMap: EMPTY_AGENT_MAP,
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
export const useSelectedSite = () =>
  useNemoStore((s) => (s.selectedSiteId ? s.sitesById[s.selectedSiteId] : null));
export const usePanels = () => useNemoStore((s) => s.panels);
export const useLeftRailTab = () => useNemoStore((s) => s.leftRailTab);
export const useRightRailTab = () => useNemoStore((s) => s.rightRailTab);
export const useAgentMap = () => useNemoStore((s) => s.agentMap);

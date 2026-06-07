import type { LngLat, Scenario, ScenarioId, ScenarioOutage } from "@/lib/types";

/**
 * The nominal "live" feed — UI chrome only, no outage.
 */
const shell = (id: ScenarioId, label: string, description: string): Scenario => ({
  id,
  label,
  description,
  seedDeactivated: [],
  synthetic: false,
});

/**
 * A pre-rendered incident: real EE/Orange mast ids (from public/raytracing/masts.geojson,
 * mirrored in the agent's OUTAGE_CATALOG) + the outage epicentre. The traffic-aware
 * restoration ETA is computed at runtime by `useScenarioTimeline` from the epicentre.
 */
const incident = (
  id: ScenarioId,
  label: string,
  description: string,
  outage: ScenarioOutage,
): Scenario => ({
  id,
  label,
  description,
  seedDeactivated: outage.siteIds,
  synthetic: true,
  outage,
});

const at = (lng: number, lat: number): LngLat => [lng, lat];

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  live: shell(
    "live",
    "Live",
    "Real-time operational feed across the London cell grid.",
  ),
  "high-demand": incident(
    "high-demand",
    "High Demand",
    "Rush-hour subscriber surge stressing the busiest cells around Bank.",
    {
      siteIds: ["TQ3263381285", "TQ3250081280", "TQ3248081251"],
      epicenter: at(-0.0905, 51.515),
      severity: "major",
    },
  ),
  "major-event": incident(
    "major-event",
    "Major Event",
    "Stadium-scale crowd in the east — localised hotspot, mutual-aid response.",
    {
      siteIds: ["TQ3776480097", "TQ3755080270", "TQ3776079840"],
      epicenter: at(-0.017, 51.503),
      severity: "major",
    },
  ),
  "infrastructure-loss": incident(
    "infrastructure-loss",
    "Infrastructure Loss",
    "Backhaul failure takes a Holborn hub offline — coverage hole opens.",
    {
      siteIds: ["TQ3070081830", "TQ3054081790", "TQ3064081980"],
      epicenter: at(-0.118, 51.52),
      severity: "critical",
    },
  ),
  "power-outage": incident(
    "power-outage",
    "Power Outage",
    "Grid fault drops Shoreditch sites to battery, then offline.",
    {
      siteIds: ["TQ3448082620", "TQ3483082690", "TQ3481082720"],
      epicenter: at(-0.06, 51.525),
      severity: "critical",
    },
  ),
};

export const SCENARIO_ORDER: ScenarioId[] = [
  "live",
  "high-demand",
  "major-event",
  "infrastructure-loss",
  "power-outage",
];

export const DEFAULT_SCENARIO: ScenarioId = "live";

// Chat keywords that name an incident scenario, so a prompt like "run the power outage
// scenario" can flip the HUD scenario switch (and repaint map + timeline) as the agent runs.
const SCENARIO_KEYWORDS: Record<Exclude<ScenarioId, "live">, string[]> = {
  "high-demand": ["high demand", "high-demand", "rush hour", "rush-hour", "surge"],
  "major-event": ["major event", "major-event", "stadium", "crowd", "concert"],
  "infrastructure-loss": ["infrastructure loss", "infrastructure-loss", "backhaul", "hub failure"],
  "power-outage": ["power outage", "power-outage", "power cut", "grid fault", "blackout"],
};

/**
 * Detect which incident scenario an operator chat prompt refers to (by label/keyword), or null.
 * Used to flip the active scenario from chat. Order follows {@link SCENARIO_ORDER}; "live" never
 * matches (it is the nominal feed).
 */
export function scenarioFromText(text: string): ScenarioId | null {
  const low = text.toLowerCase();
  for (const id of SCENARIO_ORDER) {
    if (id === "live") continue;
    const kws = SCENARIO_KEYWORDS[id as Exclude<ScenarioId, "live">];
    if (kws.some((k) => low.includes(k))) return id;
  }
  return null;
}

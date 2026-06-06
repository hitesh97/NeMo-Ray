import type { Scenario, ScenarioId } from "@/lib/types";

const HOUR = 3600_000;

/**
 * Inert scenario shells — UI chrome only.
 *
 * These carry the scenario tab strip's labels/descriptions and a default
 * timeline span so the scenarios workspace renders, but no synthetic telemetry:
 * `events` and `seedDeactivated` are empty. The hand-authored incident scripts
 * (the old `lib/mock/scenarios.ts`) were removed with the rest of the demo data.
 * Populate `events`/`seedDeactivated` from a real feed to bring them to life.
 */
const shell = (
  id: ScenarioId,
  label: string,
  description: string,
): Scenario => ({
  id,
  label,
  description,
  seedDeactivated: [],
  events: [],
  durationMs: 6 * HOUR,
  synthetic: false,
});

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  live: shell(
    "live",
    "Live",
    "Real-time operational feed across the London cell grid.",
  ),
  "high-demand": shell(
    "high-demand",
    "High Demand",
    "Rush-hour subscriber surge stressing the busiest cells.",
  ),
  "major-event": shell(
    "major-event",
    "Major Event",
    "Stadium-scale crowd — localised hotspot, mutual-aid response.",
  ),
  "infrastructure-loss": shell(
    "infrastructure-loss",
    "Infrastructure Loss",
    "Backhaul failure takes a hub offline — coverage hole opens.",
  ),
  "cyber-attack": shell(
    "cyber-attack",
    "Cyber Attack",
    "Coordinated signalling-storm against core sites.",
  ),
  "power-outage": shell(
    "power-outage",
    "Power Outage",
    "Grid fault drops sites to battery, then offline.",
  ),
};

export const SCENARIO_ORDER: ScenarioId[] = [
  "live",
  "high-demand",
  "major-event",
  "infrastructure-loss",
  "cyber-attack",
  "power-outage",
];

export const DEFAULT_SCENARIO: ScenarioId = "live";

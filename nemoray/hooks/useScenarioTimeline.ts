"use client";

import { useEffect } from "react";

import { buildScenarioTimeline } from "@/lib/geo/restoration";
import { useNemoStore } from "@/store";

const HOUR = 3600_000;

/**
 * Recomputes the active scenario's restoration timeline whenever the scenario changes, using
 * the current time of day (so the drive time reflects "current traffic"), and pushes the
 * events + {@link RestorationPlan} into the store. Scenarios with no outage (the nominal
 * "live" feed) clear the timeline. Mount ONCE — the bottom bar does so, alongside
 * useTimelinePlayback.
 */
export function useScenarioTimeline(): void {
  const scenarioId = useNemoStore((s) => s.activeScenarioId);

  useEffect(() => {
    const { scenarios, setTimeline } = useNemoStore.getState();
    const built = buildScenarioTimeline(scenarios[scenarioId], new Date());
    if (built) setTimeline(built.events, built.durationMs, built.restoration);
    else setTimeline([], 6 * HOUR, null);
  }, [scenarioId]);
}

"use client";

import { useEffect } from "react";

import { computeRestoration } from "@/lib/geo/restoration";
import { useNemoStore } from "@/store";

/**
 * Recomputes the active scenario's traffic-aware restoration estimate whenever the scenario
 * changes, using the current time of day (so the drive time reflects "current traffic"), and
 * pushes the {@link RestorationPlan} into the store for the RESTORATION ETA readout. Scenarios
 * with no outage (the nominal "live" feed) clear it. Mount ONCE — the bottom bar does so.
 */
export function useScenarioTimeline(): void {
  const scenarioId = useNemoStore((s) => s.activeScenarioId);

  useEffect(() => {
    const { scenarios, setRestoration } = useNemoStore.getState();
    const outage = scenarios[scenarioId]?.outage;
    setRestoration(outage ? computeRestoration(outage.epicenter, new Date()) : null);
  }, [scenarioId]);
}

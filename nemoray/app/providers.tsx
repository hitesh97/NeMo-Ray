"use client";

import { useEffect } from "react";
import { useNemoStore } from "@/store";
import { useCoverageTelemetry } from "@/hooks/useCoverageTelemetry";

const PANELS_KEY = "nemoray.panels";

/**
 * Client boundary. Hydrates persisted panel-collapse state AFTER mount (so SSR
 * markup matches the default), persists changes back to localStorage, and loads the
 * real pipeline run telemetry (summary.json) into the store for the KPI panels.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const panels = useNemoStore((s) => s.panels);
  const setPanels = useNemoStore((s) => s.setPanels);

  // load the real run telemetry once on mount
  useCoverageTelemetry();

  // hydrate once
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PANELS_KEY);
      if (raw) setPanels(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist
  useEffect(() => {
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
    } catch {
      /* ignore */
    }
  }, [panels]);

  return <>{children}</>;
}

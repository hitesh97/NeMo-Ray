"use client";

import { useEffect } from "react";

import { getJson } from "@/lib/api/client";
import { useNemoStore } from "@/store";
import type { CoverageTelemetry } from "@/lib/types";

/**
 * Loads the real pipeline run summary (`public/raytracing/summary.json`, written by
 * `src/export.py`) once on mount and parks it in the store. The Network Status and
 * Render Telemetry panels read it from there. On a missing/old artifact it leaves the
 * store value null and those panels show placeholders rather than throwing.
 */
export function useCoverageTelemetry() {
  const setTelemetry = useNemoStore((s) => s.setTelemetry);

  useEffect(() => {
    let cancelled = false;
    getJson<CoverageTelemetry>("/raytracing/summary.json")
      .then((t) => {
        if (!cancelled) setTelemetry(t);
      })
      .catch(() => {
        /* no artifact yet — panels degrade to placeholders */
      });
    return () => {
      cancelled = true;
    };
  }, [setTelemetry]);
}

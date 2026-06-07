"use client";

import { useEffect } from "react";

import { useNemoStore } from "@/store";

interface GpuPayload {
  device?: string | null;
  model?: string | null;
  vram_used_mib?: number | null;
  vram_total_mib?: number | null;
  gpu_util_pct?: number | null;
  source?: string;
}

/**
 * Polls the DGX-Spark agent backend for live Nemotron GPU telemetry (VRAM used / total,
 * utilisation, device, served model) and folds it into the store's `nemotron` slice. The
 * output-token rate is measured separately from the SSE stream in the store, so this hook
 * only owns the GPU snapshot. Mount it where the Stats board lives so it polls only while
 * that tab is visible; it stops on unmount.
 *
 * When no real backend is configured the route returns `{ source: "unavailable" }` and we
 * leave the figures null (the panel shows em-dashes — never a fabricated number).
 */
export function useNemotronTelemetry(intervalMs = 4000): void {
  const setNemotronGpu = useNemoStore((s) => s.setNemotronGpu);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/agent/gpu", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as GpuPayload;
        if (cancelled || d.source === "unavailable") return;
        setNemotronGpu({
          device: d.device ?? null,
          model: d.model ?? null,
          vramUsedMib: d.vram_used_mib ?? null,
          vramTotalMib: d.vram_total_mib ?? null,
          gpuUtilPct: d.gpu_util_pct ?? null,
        });
      } catch {
        /* leave figures null — panel degrades to em-dashes */
      }
    };

    poll();
    const t = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [setNemotronGpu, intervalMs]);
}

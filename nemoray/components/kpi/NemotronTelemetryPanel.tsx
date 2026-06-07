"use client";

import { useNemotron } from "@/store";
import { useNemotronTelemetry } from "@/hooks/useNemotronTelemetry";
import { Panel, PanelHeader, PanelBody, Readout } from "@/components/primitives";
import { cn } from "@/lib/cn";

/**
 * Nemotron Inference telemetry — the live cost of the agent's LLM on the DGX Spark.
 * VRAM (used / max), GPU utilisation, and the served model come from the agent backend
 * (`/api/agent/gpu`, polled here); the output-token rate + peak are measured client-side
 * from the SSE token stream (see `store/applyStreamEvent`). Everything degrades to an
 * em-dash until measured — figures are never fabricated. Runs entirely on the Spark.
 *
 * Note: the Spark's GB10 is an integrated Grace-Blackwell SoC with 128 GB LPDDR5X
 * *unified* memory shared by CPU + GPU (not discrete VRAM) — so "VRAM" here is the
 * GPU-addressable slice of that unified pool, read live from the device.
 */
export function NemotronTelemetryPanel({ className }: { className?: string }) {
  useNemotronTelemetry();
  const n = useNemotron();

  const usedGib = n.vramUsedMib != null ? n.vramUsedMib / 1024 : null;
  const totalGib = n.vramTotalMib != null ? n.vramTotalMib / 1024 : null;
  const usedPct =
    n.vramUsedMib != null && n.vramTotalMib ? (n.vramUsedMib / n.vramTotalMib) * 100 : null;

  return (
    <Panel className={cn("@container", className)}>
      <PanelHeader label="Nemotron Inference" sub="DGX SPARK · GB10 · 128 GB UNIFIED" />
      <PanelBody className="flex flex-col gap-3 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <Metric label="VRAM · used" value={dec(usedGib)} unit=" GiB" />
          <Metric label="VRAM · max" value={dec(totalGib)} unit=" GiB" />
          <Metric label="GPU util" value={num(n.gpuUtilPct)} unit="%" />
          <Metric label="VRAM · in use" value={dec(usedPct)} unit="%" />
          <Metric label="Output rate" value={dec(n.outputTokPerSec)} unit=" tok/s" />
          <Metric label="Output · peak" value={dec(n.peakTokPerSec)} unit=" tok/s" />
        </div>

        {/* VRAM usage bar */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="nm-eyebrow text-ink-faint">VRAM usage</span>
            <span className="nm-readout text-[9px] tabular-nums text-ink-dim">
              {usedGib != null && totalGib != null
                ? `${usedGib.toFixed(1)} / ${totalGib.toFixed(0)} GiB`
                : "—"}
            </span>
          </div>
          <div className="h-[3px] w-full overflow-hidden bg-bg">
            <div
              className="h-full bg-nv shadow-[0_0_8px_var(--color-nv)] transition-[width] duration-500 ease-out"
              style={{ width: `${Math.round(Math.min(100, Math.max(0, usedPct ?? 0)))}%` }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-hairline pt-3">
          <Readout label="Model" value={n.model ?? "—"} />
          <Readout label="GPU device" value={n.device ?? "—"} />
          <Readout label="Tokens out · last" value={num(n.lastOutputTokens)} />
        </div>
      </PanelBody>
    </Panel>
  );
}

/** Integer with thousands separators, or em-dash when absent. */
function num(v: number | null): string | null {
  return v === null ? null : Math.round(v).toLocaleString();
}
/** One-decimal number, or em-dash when absent. */
function dec(v: number | null): string | null {
  return v === null ? null : v.toFixed(1);
}

/** A Readout that shows an em-dash (and hides its unit) until its value loads. */
function Metric({ label, value, unit }: { label: string; value: string | null; unit?: string }) {
  const has = value !== null;
  return <Readout label={label} value={has ? value : "—"} unit={has ? unit : undefined} />;
}

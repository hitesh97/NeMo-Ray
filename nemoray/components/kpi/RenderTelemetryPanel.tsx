"use client";

import { useTelemetry } from "@/store";
import {
  Panel,
  PanelHeader,
  PanelBody,
  Readout,
  formatCompact,
} from "@/components/primitives";
import { renderedAreaKm2 } from "@/lib/telemetry";
import { cn } from "@/lib/cn";

/**
 * Render Telemetry — the real GPU cost of the last solve, straight from the pipeline
 * run summary (`public/raytracing/summary.json`, written by `src/export.py`; GPU figures
 * sampled by `src/gpu.py`). Shows the area of London ray-traced, the ray-trace count and
 * throughput, the peak VRAM the RT solve used, and GPU utilisation. Everything degrades to
 * an em-dash until the summary loads.
 *
 * Nemotron inference telemetry (VRAM, output token rate) lives in its own
 * {@link NemotronTelemetryPanel} on the same Stats board — this panel is the Sionna RT
 * solve only.
 */
export function RenderTelemetryPanel({ className }: { className?: string }) {
  const t = useTelemetry();
  const p = t?.performance;

  const area = t ? `${Math.round(renderedAreaKm2(t.coverage_bounds)).toLocaleString()}` : null;
  const tiles = p?.coverage_solve?.tiles_solved ?? null;
  const rays = t ? formatCompact(t.ray_paths) : null;
  const throughput =
    p?.ray_trace?.rays_per_s != null ? `${formatCompact(p.ray_trace.rays_per_s)}` : null;
  const vram = p?.peak_gpu_mem_mib ?? null;
  const rtTime = p?.ray_trace?.total_s ?? null;
  const gpuPeak = p?.peak_gpu_util_pct ?? null;
  const gpuMean = p?.mean_gpu_util_pct ?? null;
  const device = p?.device ?? null;

  return (
    <Panel className={cn("@container", className)}>
      <PanelHeader label="Render Telemetry" sub="DGX SPARK · SIONNA RT" />
      <PanelBody className="flex flex-col gap-3 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <Metric label="Rendered area" value={area} unit=" km²" />
          <Metric label="Tiles solved" value={num(tiles)} />
          <Metric label="Ray traces" value={rays} />
          <Metric label="Throughput" value={throughput} unit=" /s" />
          <Metric label="RT VRAM · peak" value={num(vram)} unit=" MiB" />
          <Metric label="RT time" value={dec(rtTime)} unit=" s" />
          <Metric label="GPU util · peak" value={num(gpuPeak)} unit="%" />
          <Metric label="GPU util · mean" value={dec(gpuMean)} unit="%" />
        </div>

        <div className="flex flex-col gap-3 border-t border-hairline pt-3">
          <Readout label="GPU device" value={device ?? "—"} />
        </div>
      </PanelBody>
    </Panel>
  );
}

/** Integer with thousands separators, or em-dash when absent. */
function num(n: number | null): string | null {
  return n === null ? null : n.toLocaleString();
}
/** One-decimal number, or em-dash when absent. */
function dec(n: number | null): string | null {
  return n === null ? null : n.toFixed(1);
}

/** A Readout that shows an em-dash (and hides its unit) until its value loads. */
function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: string | null;
  unit?: string;
}) {
  const has = value !== null;
  return <Readout label={label} value={has ? value : "—"} unit={has ? unit : undefined} />;
}

"use client";

import { useNemoStore, useTelemetry } from "@/store";
import { Panel, PanelHeader, PanelBody, StatusDot, type Status } from "@/components/primitives";
import { formatCompact } from "@/components/primitives";
import { cn } from "@/lib/cn";

const COVERAGE_STATUS = {
  ready: { dot: "nominal", label: "LIVE", pulse: true },
  computing: { dot: "info", label: "SYNC", pulse: true },
  idle: { dot: "idle", label: "IDLE", pulse: false },
  error: { dot: "critical", label: "FAULT", pulse: true },
} as const;

/**
 * Left-rail network status. Reports the real fleet straight from the pipeline run
 * summary (`public/raytracing/summary.json`): how many EE masts the London twin holds,
 * how many actually emitted rays in the rendered tiles, the served-coverage percentage
 * and the count of coverage holes. No synthetic subscriber or congestion figures.
 */
export function NetworkStatusPanel({ className }: { className?: string }) {
  const coverageStatus = useNemoStore((s) => s.coverageStatus);
  const t = useTelemetry();

  // LIVE once the real run summary has loaded; SYNC/FAULT follow an active recompute.
  const statusKey =
    coverageStatus === "computing"
      ? "computing"
      : coverageStatus === "error"
        ? "error"
        : t
          ? "ready"
          : "idle";
  const s = COVERAGE_STATUS[statusKey];

  const total = t?.sites_total ?? null;
  const emitting = t?.masts_emitting_rays ?? null;
  const gaps = t?.low_coverage_polys ?? null;
  const served = t?.served_pct ?? null;
  const buildings = t?.buildings ?? null;

  return (
    <Panel className={cn("@container", className)}>
      <PanelHeader
        label="Network Status"
        sub="LONDON · EE TWIN"
        right={
          <span className="flex items-center gap-1.5">
            <StatusDot status={s.dot} pulse={s.pulse} />
            <span className="nm-eyebrow text-ink-dim">{s.label}</span>
          </span>
        }
      />
      <PanelBody className="flex flex-col gap-3 overflow-y-auto p-3">
        {/* Headline — total EE masts in the digital twin */}
        <div className="flex flex-col gap-1">
          <span className="nm-eyebrow text-ink-faint">Cell Masts</span>
          <div className="flex items-baseline gap-2">
            <span className="nm-readout text-4xl leading-none tracking-tight text-ink tabular-nums">
              {total === null ? "—" : total.toLocaleString()}
            </span>
            <span className="text-[11px] leading-tight text-ink-faint">
              EE masts in twin
            </span>
          </div>
        </div>

        {/* Emitting in the rendered tiles / coverage holes */}
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Emitting" value={emitting} status="nominal" />
          <StatTile
            label="Coverage gaps"
            value={gaps}
            status={gaps && gaps > 0 ? "critical" : "idle"}
          />
        </div>

        {/* Served coverage — the headline coverage KPI from the solve */}
        <div className="flex items-center justify-between border-t border-hairline pt-2.5">
          <span className="nm-eyebrow text-ink-faint">Coverage served</span>
          <span className="nm-readout text-sm tabular-nums text-nominal">
            {served === null ? "—" : `${served.toFixed(1)}%`}
          </span>
        </div>

        {/* Buildings modelled — the OSM twin the rays bounce through */}
        <div className="flex items-center justify-between border-t border-hairline pt-2.5">
          <span className="nm-eyebrow text-ink-faint">Buildings modelled</span>
          <span className="nm-readout text-sm tabular-nums text-ink-dim">
            {buildings === null ? "—" : formatCompact(buildings)}
          </span>
        </div>
      </PanelBody>
    </Panel>
  );
}

const TILE_ACCENT: Record<Status, string> = {
  nominal: "border-l-nominal text-nominal",
  warning: "border-l-warning text-warning",
  critical: "border-l-critical text-critical",
  info: "border-l-info text-info",
  idle: "border-l-hairline-strong text-ink-dim",
};

/** A single bordered count tile. Shows an em-dash until telemetry loads. */
function StatTile({
  label,
  value,
  status,
}: {
  label: string;
  value: number | null;
  status: Status;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border border-hairline border-l-2 bg-bg/40 px-2.5 py-2",
        TILE_ACCENT[status],
      )}
    >
      <span className="nm-eyebrow text-ink-faint">{label}</span>
      <span className="nm-readout text-2xl leading-none tracking-tight tabular-nums">
        {value === null ? "—" : value.toLocaleString()}
      </span>
    </div>
  );
}

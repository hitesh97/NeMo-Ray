"use client";

import {
  Check,
  Cpu,
  Gauge,
  MapPin,
  Navigation,
  Network,
  Radar,
  Radio,
  RadioTower,
  Satellite,
  SatelliteDish,
  ShieldCheck,
  Truck,
  X,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import type { ToolCall, ToolName, ToolStatus } from "@/lib/types";

const ICON: Record<ToolName, LucideIcon> = {
  run_sionna_coverage: Radio,
  run_cuopt: Cpu,
  validate_site: ShieldCheck,
  simulate_outage: Network,
  move_mast: Satellite,
  deploy_cow: Truck,
  check_starlink: SatelliteDish,
  find_nearest: MapPin,
  locate_place: Navigation,
  nearby_places: Radar,
  describe_network: Gauge,
  find_masts: RadioTower,
};

const STATUS_TEXT: Record<ToolStatus, string> = {
  queued: "QUEUED",
  running: "RUNNING",
  success: "SUCCESS",
  error: "ERROR",
};

const STATUS_COLOR: Record<ToolStatus, string> = {
  queued: "text-ink-faint",
  running: "text-info",
  success: "text-nv",
  error: "text-critical",
};

/** One animated tool-pipeline row — icon · label · inline progress/result · status. */
export function ToolCard({ call }: { call: ToolCall }) {
  const Icon = ICON[call.name] ?? Cpu;
  const { status, label, result, progress = 0 } = call;
  const active = status === "running" || status === "success";
  const settled = status === "success" || status === "error";

  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-2 border bg-panel-2/70 px-2.5 py-1.5",
        status === "error" ? "border-critical/40" : "border-hairline",
        active && "nm-glow",
        status === "running" && "border-info/40",
        status === "success" && "border-nv/40",
      )}
      title={settled && result ? result : undefined}
    >
      <Icon
        size={13}
        className={cn(
          "shrink-0",
          status === "queued" && "text-ink-faint",
          status === "running" && "nm-pulse text-info",
          status === "success" && "text-nv",
          status === "error" && "text-critical",
        )}
      />
      <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink">
        {label}
      </span>

      {/* middle: settled → one-line result; otherwise → inline progress sliver */}
      {settled && result ? (
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[10.5px]",
            status === "error" ? "text-critical/90" : "text-ink-dim",
          )}
        >
          {result}
        </span>
      ) : status === "running" ? (
        <div className="h-[3px] min-w-0 flex-1 overflow-hidden bg-bg">
          <div
            className="h-full bg-info shadow-[0_0_8px_var(--color-info)] transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
          />
        </div>
      ) : status === "queued" ? (
        <div className="h-[3px] min-w-0 flex-1 overflow-hidden bg-bg">
          <div className="nm-shimmer h-full w-full" />
        </div>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      <span
        className={cn(
          "nm-readout flex shrink-0 items-center gap-0.5 text-[9px] uppercase tracking-[0.12em]",
          STATUS_COLOR[status],
          status === "running" && "nm-pulse",
        )}
      >
        {status === "success" && <Check size={10} />}
        {status === "error" && <X size={10} />}
        {STATUS_TEXT[status]}
      </span>
    </div>
  );
}

"use client";

import {
  Activity,
  AlertTriangle,
  FileDown,
  PlugZap,
  Radio,
  Users,
} from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";

import { Button, Dialog, Tooltip } from "@/components/primitives";
import { cn } from "@/lib/cn";
import { SCENARIOS, SCENARIO_ORDER } from "@/lib/scenarios";
import type { ScenarioId } from "@/lib/types";
import { useNemoStore } from "@/store";

type IconType = ComponentType<{ size?: number; className?: string }>;

const SCENARIO_ICON: Record<ScenarioId, IconType> = {
  live: Radio,
  "high-demand": Users,
  "major-event": Activity,
  "infrastructure-loss": AlertTriangle,
  "power-outage": PlugZap,
};

/** One bespoke HUD scenario segment (active = nv + corner ticks + inset bar). */
function ScenarioSegment({ id }: { id: ScenarioId }) {
  const scenario = SCENARIOS[id];
  const active = useNemoStore((s) => s.activeScenarioId === id);
  const setScenario = useNemoStore((s) => s.setScenario);
  const Icon = SCENARIO_ICON[id];

  return (
    <Tooltip side="top" content={scenario.description}>
      <button
        type="button"
        aria-pressed={active}
        onClick={() => setScenario(id)}
        className={cn(
          "relative flex h-7 shrink-0 items-center gap-1.5 border px-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] transition-all",
          active
            ? "border-hairline-strong bg-nv/10 text-nv"
            : "border-hairline text-ink-dim hover:border-hairline-strong hover:text-ink",
        )}
      >
        <Icon size={11} className={cn(active ? "text-nv" : "opacity-70")} />
        {scenario.label}
        {active && (
          <span className="absolute inset-x-0 -bottom-px h-[2px] bg-nv" />
        )}
      </button>
    </Tooltip>
  );
}

/** The scenario selector row: segments + Export Report. */
export function ScenarioTabs({ className }: { className?: string }) {
  const [exportOpen, setExportOpen] = useState(false);

  const activeScenarioId = useNemoStore((s) => s.activeScenarioId);
  const sites = useNemoStore((s) => s.sites);
  const deadZones = useNemoStore((s) => s.deadZones);
  const deactivatedCount = useNemoStore((s) => s.deactivatedSiteIds.length);
  const active = SCENARIOS[activeScenarioId];

  // Real fleet figures for the report summary — no synthetic KPIs.
  const onAir = sites.filter((s) => s.status === "active").length;
  const summary = [
    { label: "Cell towers", value: String(sites.length), critical: false },
    { label: "On air", value: String(onAir), critical: false },
    { label: "Offline", value: String(sites.length - onAir), critical: deactivatedCount > 0 },
    {
      label: "Critical gaps",
      value: String(deadZones.filter((d) => d.severity === "critical").length),
      critical: deadZones.filter((d) => d.severity === "critical").length > 0,
    },
  ];

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {SCENARIO_ORDER.map((id) => (
        <ScenarioSegment key={id} id={id} />
      ))}

      <div className="ml-auto" />

      {/* Export Report */}
      <Dialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        title="Export Report"
        trigger={
          <Button variant="outline" size="sm">
            <FileDown size={12} />
            Export Report
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="nm-eyebrow">Scenario</span>
            <span className="text-sm font-semibold text-nv">{active.label}</span>
          </div>
          <p className="text-xs leading-relaxed text-ink-dim">{active.description}</p>

          <div className="grid grid-cols-2 gap-px border border-hairline bg-hairline">
            {summary.map((k) => (
              <div key={k.label} className="flex flex-col gap-0.5 bg-panel-2 px-2.5 py-2">
                <span className="nm-eyebrow text-ink-faint">{k.label}</span>
                <span className={cn("nm-readout text-sm", k.critical ? "text-critical" : "text-ink")}>
                  {k.value}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-hairline pt-3">
            <span className="nm-readout text-[10px] text-ink-faint">
              {active.events.length} events · {deactivatedCount} sites offline
            </span>
            <Button variant="solid" size="sm" onClick={() => setExportOpen(false)}>
              <FileDown size={12} />
              Generate PDF
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

"use client";

import {
  Activity,
  AlertTriangle,
  PlugZap,
  Radio,
  Users,
} from "lucide-react";
import type { ComponentType } from "react";

import { Tooltip } from "@/components/primitives";
import { TechStrip } from "@/components/scenario/TechStrip";
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

/** The scenario selector row: segments + tech strip. */
export function ScenarioTabs({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {SCENARIO_ORDER.map((id) => (
        <ScenarioSegment key={id} id={id} />
      ))}

      <TechStrip className="ml-4 min-w-0 flex-1" />
    </div>
  );
}

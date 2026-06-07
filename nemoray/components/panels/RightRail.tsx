"use client";

import { Gauge, MessageSquare } from "lucide-react";
import { AgentConsole } from "@/components/agent/AgentConsole";
import { ToolPipeline } from "@/components/agent/ToolPipeline";
import { RenderTelemetryPanel } from "@/components/kpi/RenderTelemetryPanel";
import { NemotronTelemetryPanel } from "@/components/kpi/NemotronTelemetryPanel";
import { RailTabs, type RailTab } from "@/components/shell/RailTabs";
import type { RightRailTab } from "@/lib/types";
import { useNemoStore, useRightRailTab } from "@/store";

const TABS: RailTab<RightRailTab>[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "stats", label: "Stats", icon: Gauge },
];

/**
 * Right (action) rail: swaps between the AI agent console (+ tool pipeline) and the Stats
 * board (Nemotron inference + GPU/RT render telemetry — all on the DGX Spark).
 */
export function RightRail() {
  const tab = useRightRailTab();
  const setTab = useNemoStore((s) => s.setRightRailTab);

  return (
    <div className="flex h-full flex-col">
      <RailTabs tabs={TABS} active={tab} onSelect={setTab} reserve="left" />
      <div className="min-h-0 flex-1 p-2">
        {tab === "chat" ? (
          <div className="flex h-full flex-col gap-2">
            <AgentConsole className="min-h-0 flex-1" />
            <ToolPipeline className="shrink-0" />
          </div>
        ) : (
          <StatsBoard />
        )}
      </div>
    </div>
  );
}

/**
 * The Stats tab: a scrollable stack of stat cards — Nemotron inference telemetry (VRAM,
 * token rate) on top, then the Sionna RT render telemetry. Both run on the DGX Spark.
 */
function StatsBoard() {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      <NemotronTelemetryPanel className="shrink-0" />
      <RenderTelemetryPanel className="shrink-0" />
    </div>
  );
}

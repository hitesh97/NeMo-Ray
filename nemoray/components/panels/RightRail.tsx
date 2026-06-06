"use client";

import { Gauge, MessageSquare, Target } from "lucide-react";
import { AgentConsole } from "@/components/agent/AgentConsole";
import { ToolPipeline } from "@/components/agent/ToolPipeline";
import { ProposalList } from "@/components/optimiser/ProposalList";
import { RenderTelemetryPanel } from "@/components/kpi/RenderTelemetryPanel";
import { Panel, PanelHeader, PanelBody } from "@/components/primitives";
import { RailTabs, type RailTab } from "@/components/shell/RailTabs";
import type { RightRailTab } from "@/lib/types";
import { useNemoStore, useRightRailTab } from "@/store";

const TABS: RailTab<RightRailTab>[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "cuopt", label: "cuOpt", icon: Target },
  { id: "stats", label: "Stats", icon: Gauge },
];

/**
 * Right (action) rail: swaps between the AI agent console (+ tool pipeline), the cuOpt
 * proposal list, and the Stats board (GPU/RT render telemetry, with room for more cards).
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
        ) : tab === "cuopt" ? (
          <ProposalList className="h-full" />
        ) : (
          <StatsBoard />
        )}
      </div>
    </div>
  );
}

/**
 * The Stats tab: a scrollable stack of stat cards. Render Telemetry is the first real
 * card; the rest are placeholders to be filled in later.
 */
function StatsBoard() {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      <RenderTelemetryPanel className="shrink-0" />
      <PlaceholderCard label="Coverage Quality" sub="SIGNAL · RSRP" />
      <PlaceholderCard label="Optimisation" sub="cuOpt · VERIFY" />
    </div>
  );
}

/** An empty stat card — a styled slot for a metric block we haven't wired yet. */
function PlaceholderCard({ label, sub }: { label: string; sub?: string }) {
  return (
    <Panel className="shrink-0">
      <PanelHeader label={label} sub={sub} />
      <PanelBody className="flex items-center justify-center p-6">
        <span className="nm-eyebrow text-ink-faint">Coming soon</span>
      </PanelBody>
    </Panel>
  );
}

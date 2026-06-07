"use client";

import { Timer } from "lucide-react";
import { Panel, PanelHeader, PanelBody, StatusDot } from "@/components/primitives";
import { cn } from "@/lib/cn";
import { useNemoStore } from "@/store";

/** Scenarios workspace overlay: active scenario summary + restoration ETA. */
export function ScenarioDetail({ className }: { className?: string }) {
  const scenarioId = useNemoStore((s) => s.activeScenarioId);
  const scenario = useNemoStore((s) => s.scenarios[scenarioId]);
  const deactivated = useNemoStore((s) => s.deactivatedSiteIds);
  // Traffic-aware restoration plan for the active scenario's outage (useScenarioTimeline).
  const restoration = useNemoStore((s) => s.restoration);

  return (
    <Panel frame className={cn("bg-panel/90", className)}>
      <PanelHeader
        label="SCENARIO BRIEF"
        sub={scenario.synthetic ? "SYNTHETIC" : "LIVE FEED"}
        right={<StatusDot status={scenario.synthetic ? "warning" : "nominal"} pulse />}
      />
      <PanelBody className="flex flex-col gap-4 p-3">
        <div>
          <div className="text-lg font-semibold uppercase tracking-[0.14em] text-nv">
            {scenario.label}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-ink-dim">{scenario.description}</p>
        </div>

        <div className="border border-hairline bg-bg/50 p-2">
          <div className="nm-eyebrow">Sites Offline</div>
          <div className="nm-readout mt-0.5 text-xl text-ink">{deactivated.length}</div>
        </div>

        {restoration && (
          <div className="border border-hairline bg-bg/50 p-2.5">
            <div className="nm-eyebrow mb-1.5 flex items-center gap-1.5">
              <Timer size={11} className="text-nv" />
              Restoration ETA
            </div>
            <div className="flex items-baseline justify-between">
              <span className="truncate text-xs text-ink-dim">{restoration.stationName}</span>
              <span className="nm-readout shrink-0 text-lg text-nv">
                {restoration.totalMin} min
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-px border border-hairline bg-hairline">
              {[
                { label: "Dispatch", value: `${restoration.dispatchMin}m` },
                { label: `Tow ×${restoration.trafficFactor}`, value: `${restoration.driveMin}m` },
                { label: "Setup", value: `${restoration.setupMin}m` },
              ].map((c) => (
                <div key={c.label} className="bg-panel-2 px-1.5 py-1">
                  <div className="nm-eyebrow text-[8.5px] text-ink-faint">{c.label}</div>
                  <div className="nm-readout text-sm text-ink">{c.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

"use client";

import { cn } from "@/lib/cn";
import { Panel, PanelHeader, PanelBody } from "@/components/primitives";
import { useNemoStore } from "@/store";
import { ToolCard } from "./ToolCard";

const GHOST_SLOTS = ["DIAGNOSE", "ROOT CAUSE", "FAILOVER"] as const;
const MAX_VISIBLE = 6;

/**
 * The TOOL PIPELINE strip. Shows the most recent tool calls as animated cards;
 * before any run, three ghost slots keep the structure legible.
 */
export function ToolPipeline({ className }: { className?: string }) {
  const toolCalls = useNemoStore((s) => s.toolCalls);
  const recent = toolCalls.slice(-MAX_VISIBLE);
  const running = toolCalls.some((t) => t.status === "running");

  return (
    <Panel className={className}>
      <PanelHeader
        label="TOOL PIPELINE"
        right={
          <span
            className={cn(
              "nm-readout text-[9px] uppercase tracking-[0.12em]",
              running ? "text-info" : "text-ink-faint",
            )}
          >
            {running ? "EXECUTING" : `${toolCalls.length} CALLS`}
          </span>
        }
      />
      <PanelBody className="p-2">
        {recent.length === 0 ? (
          <div className="flex flex-col gap-1">
            {GHOST_SLOTS.map((slot) => (
              <div
                key={slot}
                className="flex items-center gap-2 border border-dashed border-hairline bg-bg/40 px-2.5 py-1.5"
              >
                <span className="nm-eyebrow text-[8px] text-ink-faint">SLOT</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                  {slot}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {recent.map((call) => (
              <ToolCard key={call.id} call={call} />
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

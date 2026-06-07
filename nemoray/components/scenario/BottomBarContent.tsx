"use client";

import { ScenarioTabs } from "@/components/scenario/ScenarioTabs";
import { useScenarioTimeline } from "@/hooks/useScenarioTimeline";
import { cn } from "@/lib/cn";

/**
 * The bottom-bar block: the scenario selector. The shell drops this into the
 * bottom-bar region. (The event-timeline scrubber was removed.)
 */
export function BottomBarContent({ className }: { className?: string }) {
  // Recompute the active scenario's traffic-aware restoration ETA on scenario change.
  useScenarioTimeline();

  return (
    <div
      className={cn(
        "flex items-center border-t border-hairline-strong bg-panel/80 backdrop-blur-sm",
        className,
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="nm-eyebrow w-[88px] shrink-0">Scenarios</span>
        <ScenarioTabs className="min-w-0 flex-1" />
      </div>
    </div>
  );
}

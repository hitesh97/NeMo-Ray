"use client";

import type { ReactNode } from "react";
import { AgentRunner } from "@/components/agent/AgentRunner";
import { LeftRail } from "@/components/panels/LeftRail";
import { RightRail } from "@/components/panels/RightRail";
import { BottomBar } from "@/components/panels/BottomBar";
import { TooltipProvider } from "@/components/primitives";
import { DeckScene } from "@/components/map/DeckScene";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useNemoStore } from "@/store";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { TopBar } from "./TopBar";

/**
 * The mission-control shell. A fixed, non-scrolling instrument: a thin brand
 * bar over a middle row (collapsible left rail · persistent map · collapsible
 * right rail) above a collapsible bottom bar. Each rail carries its own tab
 * strip to swap what it shows (Network/Scenarios · Chat/cuOpt). `children`
 * render in the centre stage per workspace. (The Cesium map surface was
 * removed; the centre is now a plain backdrop for workspace content.)
 */
export function AppShell({ children }: { children: ReactNode }) {
  const panels = useNemoStore((s) => s.panels);
  const togglePanel = useNemoStore((s) => s.togglePanel);
  useKeyboardShortcuts();

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-bg">
        <TopBar />

        {/* middle row */}
        <div className="flex min-h-0 flex-1">
          <CollapsiblePanel
            side="left"
            label="Context"
            collapsed={panels.left}
            onToggle={() => togglePanel("left")}
            expandedSize={320}
          >
            <LeftRail />
          </CollapsiblePanel>

          <main className="relative min-w-0 flex-1 overflow-hidden bg-bg nm-grid-bg">
            {/* live deck.gl coverage twin (centre stage) */}
            <DeckScene />
            {/* per-workspace content overlaid on the map */}
            <div className="pointer-events-none absolute inset-0 z-10 flex p-3">
              {children}
            </div>
          </main>

          <CollapsiblePanel
            side="right"
            label="Assistant"
            collapsed={panels.right}
            onToggle={() => togglePanel("right")}
            expandedSize={372}
          >
            <RightRail />
          </CollapsiblePanel>
        </div>

        {/* bottom bar */}
        <CollapsiblePanel
          side="bottom"
          label="Timeline · Scenarios"
          collapsed={panels.bottom}
          onToggle={() => togglePanel("bottom")}
          expandedSize={150}
        >
          <BottomBar />
        </CollapsiblePanel>

        <AgentRunner />
      </div>
    </TooltipProvider>
  );
}

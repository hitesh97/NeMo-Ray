"use client";

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useNemoStore } from "@/store";
import type { LayerId } from "@/lib/types";
import { cn } from "@/lib/cn";

/**
 * On-map key for the deck.gl coverage twin. A compact, collapsible overlay
 * (bottom-right of the map stage) that explains every visual the surface paints:
 * the ray load ramp, mast beacons, emergency-service pins, dead zones, building
 * height shade and place hubs.
 *
 * Colours are read from the `--map-*` tokens in app/styles/tokens/colors.css,
 * which mirror the raw RGB constants in components/map/DeckScene.tsx (chrome lint
 * forbids raw hex here). Each row is tied to a {@link LayerId}: when that layer is
 * toggled off in the left-rail Map Layers panel the row dims, so the key always
 * reflects what's actually on screen. This is overlay chrome, not a map *surface*,
 * so it may read the store (INVARIANTS §2 only locks the surface to props).
 */

type Swatch =
  | { kind: "ramp"; gradient: string; min: string; max: string }
  | { kind: "dot"; color: string }
  | { kind: "dots"; items: { color: string; label: string }[] };

interface LegendRow {
  layer: LayerId;
  label: string;
  swatch: Swatch;
}

// One row per map layer group, in roughly top-to-bottom visual importance.
const ROWS: LegendRow[] = [
  {
    layer: "rays",
    label: "Coverage Rays · mast load",
    swatch: {
      kind: "ramp",
      gradient: "var(--map-load-gradient)",
      min: "Light",
      max: "Stressed",
    },
  },
  { layer: "masts", label: "Cell Masts (EE)", swatch: { kind: "dot", color: "var(--map-mast-ee)" } },
  {
    layer: "proposed",
    label: "Proposed Masts (cuOpt)",
    swatch: { kind: "dot", color: "var(--map-mast-proposed)" },
  },
  {
    layer: "services",
    label: "Emergency Services",
    swatch: {
      kind: "dots",
      items: [
        { color: "var(--map-service-police)", label: "Police" },
        { color: "var(--map-service-fire)", label: "Fire" },
        { color: "var(--map-service-hospital)", label: "Hospital" },
      ],
    },
  },
  {
    layer: "deadzone",
    label: "Dead Zones · coverage holes",
    swatch: { kind: "dot", color: "var(--map-deadzone)" },
  },
  {
    layer: "buildings",
    label: "Buildings · height",
    swatch: {
      kind: "ramp",
      gradient: "var(--map-building-gradient)",
      min: "Low",
      max: "Tall",
    },
  },
  { layer: "labels", label: "Place Hubs", swatch: { kind: "dot", color: "var(--map-hub)" } },
];

function Dot({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-[var(--line)]"
      style={{ background: color } as CSSProperties}
    />
  );
}

function SwatchView({ swatch }: { swatch: Swatch }) {
  if (swatch.kind === "dot") return <Dot color={swatch.color} />;
  if (swatch.kind === "dots") {
    return (
      <span className="flex items-center gap-1.5">
        {swatch.items.map((it) => (
          <Dot key={it.label} color={it.color} />
        ))}
      </span>
    );
  }
  // ramp
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[9px] text-ink-faint">{swatch.min}</span>
      <span
        className="h-2.5 w-12 rounded-full ring-1 ring-[var(--line)]"
        style={{ background: swatch.gradient } as CSSProperties}
      />
      <span className="text-[9px] text-ink-faint">{swatch.max}</span>
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("transition-transform duration-150", open ? "rotate-180" : "rotate-0")}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Shell({ children }: { children: ReactNode }) {
  // Anchored bottom-right of the map stage; opt back into pointer events (the
  // workspace overlay above the map is pointer-events-none).
  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 z-20 w-[224px]">{children}</div>
  );
}

export function MapLegend() {
  const layers = useNemoStore((s) => s.layers);
  const [open, setOpen] = useState(true);

  return (
    <Shell>
      <div className="overflow-hidden rounded-[var(--radius-hud)] border border-hairline bg-panel/85 backdrop-blur-sm shadow-[var(--shadow-md)]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex h-8 w-full items-center gap-2.5 px-3 text-ink-dim transition-colors hover:text-ink"
        >
          <span className="nm-card-tick" />
          <span className="nm-eyebrow flex-1 text-left">Map Legend</span>
          <Chevron open={open} />
        </button>

        {open && (
          <div className="flex flex-col gap-2 border-t border-[var(--line-subtle)] px-3 py-2.5">
            {ROWS.map((row) => {
              const off = !layers[row.layer]?.visible;
              return (
                <div
                  key={row.layer}
                  className={cn(
                    "flex items-center justify-between gap-2 transition-opacity",
                    off && "opacity-35",
                  )}
                  title={off ? `${row.label} (layer hidden)` : row.label}
                >
                  <span className="truncate text-[11px] text-ink-dim">{row.label}</span>
                  <SwatchView swatch={row.swatch} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );
}

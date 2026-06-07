"use client";

import { useNemoStore } from "@/store";
import { cn } from "@/lib/cn";

/**
 * Camera-view toggle — a small on-map control that swaps between the two scene framings:
 *
 *  • Antenna  → `flyToLondon`: dive into the 3D coverage twin (masts, rays, buildings).
 *  • Satellite → `flyToGlobe`: pull out to the globe where the live Starlink constellation
 *    (from `/api/starlink`) is visible and clickable.
 *
 * It issues one-shot camera intents on the store's camera bus (`requestCamera`); the active
 * framing is inferred from the last command so the matching button highlights. DeckScene
 * handles the actual `flyTo` (see its camera-command effect + satellite layers).
 */
export function CameraViewPanel() {
  const requestCamera = useNemoStore((s) => s.requestCamera);
  const cameraCommand = useNemoStore((s) => s.cameraCommand);
  const isGlobe = cameraCommand?.type === "flyToGlobe";

  return (
    <div
      className={cn(
        "flex flex-col gap-1 p-1.5",
        "rounded-[var(--radius-card)]",
        "border border-[var(--line)] bg-[var(--surface-raised)]",
        "shadow-[var(--shadow-card)]",
      )}
    >
      {/* Antenna — fly to the London coverage view */}
      <button
        onClick={() => requestCamera("flyToLondon")}
        title="Coverage view"
        aria-label="Coverage view"
        className={cn(
          "nm-btn nm-btn--sm nm-btn--ghost",
          "flex h-8 w-8 items-center justify-center",
          !isGlobe && "text-nv",
        )}
      >
        <AntennaIcon />
      </button>

      {/* Satellite — fly out to the globe / constellation view */}
      <button
        onClick={() => requestCamera("flyToGlobe")}
        title="Global / Starlink view"
        aria-label="Global / Starlink view"
        className={cn(
          "nm-btn nm-btn--sm nm-btn--ghost",
          "flex h-8 w-8 items-center justify-center",
          isGlobe && "text-nv",
        )}
      >
        <SatelliteIcon />
      </button>
    </div>
  );
}

function AntennaIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      {/* Mast shaft */}
      <line x1="9" y1="16" x2="9" y2="6" />
      {/* Cross-arm */}
      <line x1="6" y1="10" x2="12" y2="10" />
      {/* Signal arcs */}
      <path d="M5.5 7.5 A5 5 0 0 1 12.5 7.5" strokeLinejoin="round" />
      <path d="M3.5 5 A8 8 0 0 1 14.5 5" strokeLinejoin="round" />
    </svg>
  );
}

function SatelliteIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Bus body */}
      <rect x="6" y="7" width="6" height="4" rx="0.5" />
      {/* Left solar panel */}
      <rect x="1" y="7.5" width="4" height="3" rx="0.25" />
      <line x1="5" y1="9" x2="6" y2="9" />
      {/* Right solar panel */}
      <rect x="13" y="7.5" width="4" height="3" rx="0.25" />
      <line x1="12" y1="9" x2="13" y2="9" />
      {/* Antenna dish */}
      <line x1="9" y1="7" x2="9" y2="4" />
      <path d="M7 4.5 A2.5 2.5 0 0 1 11 4.5" />
    </svg>
  );
}

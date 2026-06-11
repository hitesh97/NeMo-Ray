"use client";

import { useNemoStore } from "@/store";
import { DeckScene } from "./DeckScene";

/**
 * MapMount — the single component allowed to read the Zustand store on behalf of the
 * map surface (INVARIANTS §2). It selects the layer-visibility state, the agent-driven
 * map overlay (dead-zone highlights, COW + source station, located buildings) and the
 * camera command bus, and hands them to {@link DeckScene} as props — so the surface
 * itself stays store-free. The left-rail "Map Layers" toggles drive `layers`; the
 * Nemotron agent's `map_action` directives drive `directives`; clicking a mast on the
 * surface calls `onPickMast`, which references it in the chat composer.
 */
export function MapMount() {
  const layers = useNemoStore((s) => s.layers);
  const directives = useNemoStore((s) => s.agentMap);
  const cameraCommand = useNemoStore((s) => s.cameraCommand);
  const referencedSiteIds = useNemoStore((s) => s.referencedSiteIds);
  const artifactsNonce = useNemoStore((s) => s.artifactsNonce);
  const deactivatedSiteIds = useNemoStore((s) => s.deactivatedSiteIds);
  const toggleReferencedSite = useNemoStore((s) => s.toggleReferencedSite);
  return (
    <DeckScene
      layers={layers}
      directives={directives}
      cameraCommand={cameraCommand}
      referencedSiteIds={referencedSiteIds}
      artifactsNonce={artifactsNonce}
      deactivatedSiteIds={deactivatedSiteIds}
      onPickMast={toggleReferencedSite}
    />
  );
}

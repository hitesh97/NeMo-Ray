"use client";

import { useNemoStore } from "@/store";
import { DeckScene } from "./DeckScene";

/**
 * MapMount — the single component allowed to read the Zustand store on behalf of the
 * map surface (INVARIANTS §2). It selects the layer-visibility state and hands it to
 * {@link DeckScene} as props, so the surface itself stays store-free and the left-rail
 * "Map Layers" toggles drive what the deck.gl scene renders.
 */
export function MapMount() {
  const layers = useNemoStore((s) => s.layers);
  return <DeckScene layers={layers} />;
}

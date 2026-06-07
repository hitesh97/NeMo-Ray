import type { LayerId, LayerState } from "@/lib/types";

export interface LayerMeta {
  id: LayerId;
  label: string;
  hint: string;
}

/**
 * Map-layer toggles shown in the left rail (order matters). Each id controls a real
 * group of layers on the deck.gl surface — see MAP_LAYER_IDS in
 * components/map/DeckScene.tsx for the id→deck-layer mapping.
 */
export const LAYER_META: LayerMeta[] = [
  { id: "buildings", label: "Buildings", hint: "Extruded OSM footprints" },
  { id: "rays", label: "Coverage Rays", hint: "Animated signal traces" },
  { id: "masts", label: "Cell Masts (EE)", hint: "Existing EE antenna sites" },
  { id: "proposed", label: "Proposed Masts", hint: "cuOpt-proposed sites" },
  { id: "deadzone", label: "Dead Zones", hint: "Coverage holes" },
  { id: "coverage", label: "Coverage Heatmap", hint: "Best-server signal (dBm) raster" },
  { id: "services", label: "Emergency Services", hint: "Police / fire / hospital pins" },
  { id: "labels", label: "Labels", hint: "Place & landmark labels" },
];

export const DEFAULT_LAYERS: Record<LayerId, LayerState> = {
  buildings: { visible: true, opacity: 1 },
  rays: { visible: true, opacity: 1 },
  masts: { visible: true, opacity: 1 },
  proposed: { visible: true, opacity: 1 },
  deadzone: { visible: true, opacity: 1 },
  // Off by default — flip it on from the Map Layers panel.
  coverage: { visible: false, opacity: 0.7 },
  services: { visible: true, opacity: 1 },
  labels: { visible: true, opacity: 1 },
};

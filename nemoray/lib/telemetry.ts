import type { CoverageTelemetry } from "@/lib/types";

/**
 * Rendered geographic area (km²) derived from the solved coverage bounds
 * (equirectangular approximation — exact enough at city scale). This is the real
 * extent the pipeline ray-traced, straight from `summary.json`'s `coverage_bounds`.
 */
export function renderedAreaKm2(b: CoverageTelemetry["coverage_bounds"]): number {
  const latMid = ((b.south + b.north) / 2) * (Math.PI / 180);
  const w = (b.east - b.west) * 111.32 * Math.cos(latMid);
  const h = (b.north - b.south) * 110.54;
  return Math.abs(w * h);
}

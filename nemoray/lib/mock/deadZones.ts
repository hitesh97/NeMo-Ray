import { MOCK_SITES } from "@/lib/mock/sites";
import type { DeadZone, Site, SiteId } from "@/lib/types";

/** Normalised-space coverage contribution of one site at a point. */
function contribution(site: Site, nx: number, ny: number): number {
  const dx = nx - site.placement.x;
  const dy = ny - site.placement.y;
  const dist = Math.hypot(dx, dy);
  // Range scales with tx power; aspect-correct y a touch (bbox is wider than tall).
  const range = 0.07 + (site.txPowerDbm - 43) * 0.012;
  const gain = Math.exp(-((dist / range) ** 2));
  return gain * (0.85 + (site.txPowerDbm - 43) * 0.05);
}

/**
 * Dead zones (coverage holes) derived from the active site set. Deactivating a
 * site punches a hole that persists only if neighbouring cells can't fill the
 * gap — the money-shot when an operator takes a tower offline.
 *
 * Formerly carried inside the radio-map heatmap (`computeMockRadioMap`); the
 * heatmap has been removed, so the dead-zone derivation lives here on its own.
 */
export function computeDeadZones(
  deactivatedSiteIds: SiteId[],
  sites: Site[] = MOCK_SITES,
): DeadZone[] {
  const dead = new Set(deactivatedSiteIds);
  const active = sites.filter((s) => !dead.has(s.id));

  return deactivatedSiteIds
    .map((id) => sites.find((s) => s.id === id))
    .filter((s): s is Site => Boolean(s))
    .map((s) => {
      // Does the gap actually persist after neighbours fill in?
      const residual = active.reduce(
        (m, a) => Math.max(m, contribution(a, s.placement.x, s.placement.y)),
        0,
      );
      const severity: DeadZone["severity"] =
        residual < 0.25 ? "critical" : residual < 0.5 ? "major" : "minor";
      return {
        id: `dz-${s.id}`,
        center: s.placement,
        radius: 0.05 + (s.txPowerDbm - 43) * 0.01,
        centroid: s.position,
        severity,
        causeSiteId: s.id,
      };
    });
}

import type { LngLat, RestorationPlan } from "@/lib/types";

/**
 * Traffic-aware Cell-on-Wheels restoration model — the RESTORATION ETA readout.
 *
 * A mast outage opens a coverage hole; the nearest fire station tows its garaged COW to the
 * outage, raises the mast and brings the cell (Starlink-backhauled) online. This module
 * estimates how long that takes from the *current* time of day, so the timeline reflects
 * "current traffic and map routing". It's a deterministic synthetic estimate (no external
 * routing API) — the agent's `deploy_cow` computes the authoritative figure over the full
 * fire-station dataset; this is the projected scenario view.
 *
 * The constants MIRROR the agent's `agent/nemoray_modelling/emergency.py` (`ROAD_WINDING`,
 * `COW_SPEED_KMH`, `DISPATCH_MIN`, `COW_SETUP_MIN`, `traffic_multiplier`) — keep them in sync.
 */

const ROAD_WINDING = 1.4; // road distance ≈ great-circle × this
const COW_SPEED_KMH = 30; // mean tow speed through London streets (free-flow)
const DISPATCH_MIN = 4; // crew muster + hook up the COW before rolling
const COW_SETUP_MIN = 12; // park, raise the mast, bring the cell + Starlink uplink online

/** Representative central-London fire-station COW depots (name + [lng, lat]). The agent uses
 * the full LFB dataset; this bundled subset keeps the projected timeline client-side. */
const FIRE_DEPOTS: { name: string; coord: LngLat }[] = [
  { name: "Soho", coord: [-0.1338, 51.5126] },
  { name: "Euston", coord: [-0.134, 51.5295] },
  { name: "Lambeth", coord: [-0.1184, 51.4928] },
  { name: "Islington", coord: [-0.105, 51.534] },
  { name: "Dowgate (City)", coord: [-0.089, 51.511] },
  { name: "Shoreditch", coord: [-0.079, 51.5265] },
  { name: "Whitechapel", coord: [-0.061, 51.5165] },
  { name: "Poplar", coord: [-0.019, 51.509] },
];

/** Great-circle distance between two [lng, lat] points, in km. */
export function haversineKm([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const r = 6371.0088;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function nearestDepot(epicenter: LngLat): { name: string; km: number } {
  let best = FIRE_DEPOTS[0];
  let bestKm = Infinity;
  for (const d of FIRE_DEPOTS) {
    const km = haversineKm(epicenter, d.coord);
    if (km < bestKm) {
      best = d;
      bestKm = km;
    }
  }
  return { name: best.name, km: bestKm };
}

/** Congestion factor by hour of day (local ≈ UTC). Rush hours slow the tow. */
export function trafficMultiplier(hour: number): number {
  if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18)) return 1.6;
  if (hour >= 10 && hour <= 15) return 1.25;
  if (hour >= 19 && hour <= 21) return 1.15;
  return 1.0;
}

/** Traffic-aware restoration breakdown for an outage epicentre at time `now`. */
export function computeRestoration(epicenter: LngLat, now: Date = new Date()): RestorationPlan {
  const { name, km } = nearestDepot(epicenter);
  const factor = trafficMultiplier(now.getHours());
  const roadKm = km * ROAD_WINDING;
  const driveMin = (roadKm / COW_SPEED_KMH) * 60 * factor;
  const total = DISPATCH_MIN + driveMin + COW_SETUP_MIN;
  return {
    stationName: `${name} Fire Station`,
    dispatchMin: Math.round(DISPATCH_MIN),
    driveMin: Math.round(driveMin),
    setupMin: Math.round(COW_SETUP_MIN),
    totalMin: Math.round(total),
    trafficFactor: factor,
  };
}


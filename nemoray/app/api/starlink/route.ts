import { readFileSync } from "fs";
import { join } from "path";
import * as satellite from "satellite.js";

export const revalidate = 15;

export interface SatellitePosition {
  name: string;
  norad_id: number;
  lon: number;
  lat: number;
  altitude_km: number;
}

function parseTleBlocks(text: string): Array<[string, string, string]> {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const blocks: Array<[string, string, string]> = [];
  for (let i = 0; i + 2 < lines.length; ) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1.startsWith("1 ") && line2.startsWith("2 ")) {
      blocks.push([name, line1, line2]);
      i += 3;
    } else {
      i += 1;
    }
  }
  return blocks;
}

function propagateAll(
  blocks: Array<[string, string, string]>,
  gmst: number,
  date: Date,
): SatellitePosition[] {
  const results: SatellitePosition[] = [];
  for (const [name, line1, line2] of blocks) {
    try {
      const satrec = satellite.twoline2satrec(line1, line2);
      const pv = satellite.propagate(satrec, date);
      if (!pv || typeof pv.position === "boolean" || !pv.position) continue;
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      const alt = geo.height; // km
      if (alt < 0) continue;
      results.push({
        name: name.trim(),
        norad_id: parseInt(satrec.satnum, 10),
        lon: satellite.degreesLong(geo.longitude),
        lat: satellite.degreesLat(geo.latitude),
        altitude_km: alt,
      });
    } catch {
      // malformed TLE — skip
    }
  }
  return results;
}

// TLE source: live CelesTrak fetch (6 h in-memory cache) → bundled snapshot fallback.
// TLEs decay fast; propagating today's clock over a stale snapshot drifts by hundreds of
// km, so prefer the live set whenever the box is online.
const CELESTRAK_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle";
const TLE_TTL_MS = 6 * 3_600_000;
let tleCache: { text: string; fetchedAt: number } | null = null;

async function loadTleText(): Promise<string> {
  const now = Date.now();
  if (tleCache && now - tleCache.fetchedAt < TLE_TTL_MS) return tleCache.text;
  try {
    const res = await fetch(CELESTRAK_URL, {
      headers: { "User-Agent": "NeMo-Ray/0.2 (+https://github.com/Harrishayy/NeMo-Ray)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const text = await res.text();
      if (text.includes("STARLINK")) {
        tleCache = { text, fetchedAt: now };
        return text;
      }
    }
  } catch {
    // offline — fall through to the last good fetch, then the bundled snapshot
  }
  if (tleCache) return tleCache.text;
  return readFileSync(join(process.cwd(), "data", "starlink_tle.txt"), "utf-8");
}

let cachedResponse: { satellites: SatellitePosition[]; fetchedAt: string } | null = null;
let cacheExpiry = 0;

export async function GET() {
  const now = Date.now();
  if (cachedResponse && now < cacheExpiry) {
    return Response.json(cachedResponse);
  }

  const text = await loadTleText();
  const blocks = parseTleBlocks(text);

  const date = new Date(now);
  const gmst = satellite.gstime(date);
  const satellites = propagateAll(blocks, gmst, date);

  const body = { satellites, fetchedAt: date.toISOString() };
  cachedResponse = body;
  cacheExpiry = now + 15_000;

  return Response.json(body);
}

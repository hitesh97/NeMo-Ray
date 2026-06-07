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

let cachedResponse: { satellites: SatellitePosition[]; fetchedAt: string } | null = null;
let cacheExpiry = 0;

export async function GET() {
  const now = Date.now();
  if (cachedResponse && now < cacheExpiry) {
    return Response.json(cachedResponse);
  }

  const tlePath = join(process.cwd(), "data", "starlink_tle.txt");
  const text = readFileSync(tlePath, "utf-8");
  const blocks = parseTleBlocks(text);

  const date = new Date(now);
  const gmst = satellite.gstime(date);
  const satellites = propagateAll(blocks, gmst, date);

  const body = { satellites, fetchedAt: date.toISOString() };
  cachedResponse = body;
  cacheExpiry = now + 15_000;

  return Response.json(body);
}

import fs from 'node:fs';
import path from 'node:path';
import { correctFireEastingNorthing, correctHospitalLatLng } from '@/lib/geo/datasetCoordinates';
import type {
  EmergencyService,
  EmergencyServicesPayload,
  EmergencyServiceType,
} from '@/types/emergency';

const DATA_DIR = path.join(process.cwd(), 'data');
const POLICE_PATH = path.join(DATA_DIR, 'police-stations-london.csv');
const FIRE_PATH = path.join(DATA_DIR, 'fire-stations-london.csv');
const HOSPITAL_PATH = path.join(DATA_DIR, 'hospitals-england.csv');

// London bounding box (see nemoray/CLAUDE.md) — the hospital dataset covers all
// of England, so we clip it to London to match the other layers.
const LONDON_BBOX = { minLng: -0.51, maxLng: 0.334, minLat: 51.286, maxLat: 51.686 };

function isInLondon(lat: number, lng: number): boolean {
  return (
    lng >= LONDON_BBOX.minLng &&
    lng <= LONDON_BBOX.maxLng &&
    lat >= LONDON_BBOX.minLat &&
    lat <= LONDON_BBOX.maxLat
  );
}

// Split into records tolerant of LF, CR-only (the police export uses classic-Mac
// `\r`) and CRLF line endings; drop blank lines.
function splitLines(csv: string): string[] {
  return csv.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
}

// Minimal RFC-4180-ish field splitter handling double-quoted fields with commas
// (e.g. `"Chelsea, London"`) and escaped quotes.
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      i++;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  values.push(current.trim());
  return values;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function slug(value: string, fallback: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  );
}

function titleCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// Police closures: `name,local authority,longitude,latitude,status,current,proposed`.
// Already WGS84 (verified — see datasetCoordinates). Longitude precedes latitude.
function parsePolice(csv: string): EmergencyService[] {
  const lines = splitLines(csv);
  return lines.slice(1).flatMap((line, index): EmergencyService[] => {
    const cols = parseCsvLine(line);
    const lng = parseNumber(cols[2]);
    const lat = parseNumber(cols[3]);
    if (lat === null || lng === null) return [];
    const name = titleCase(cols[0] ?? 'Police Station');
    return [
      {
        id: `police-${slug(cols[0] ?? '', String(index))}`,
        type: 'police',
        name,
        lat,
        lng,
        borough: cols[1] ? titleCase(cols[1]) : undefined,
        status: cols[4] || undefined,
      },
    ];
  });
}

// London Fire Brigade assets: `OBJECTID,Borough,Holding_Name,Address,Post_Code,
// UPRN,Easting,Northing`. Coordinates are OS National Grid (EPSG:27700) → WGS84.
function parseFire(csv: string): EmergencyService[] {
  const lines = splitLines(csv);
  return lines.slice(1).flatMap((line, index): EmergencyService[] => {
    const cols = parseCsvLine(line);
    const easting = parseNumber(cols[6]);
    const northing = parseNumber(cols[7]);
    if (easting === null || northing === null) return [];
    const { lat, lng } = correctFireEastingNorthing(easting, northing);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const name = `${titleCase(cols[2] ?? 'Fire Station')} Fire Station`;
    return [
      {
        id: `fire-${slug(cols[0] || cols[2] || '', String(index))}`,
        type: 'fire',
        name,
        lat,
        lng,
        borough: cols[1] ? titleCase(cols[1]) : undefined,
        address: [cols[3], cols[4]].filter(Boolean).join(', ') || undefined,
      },
    ];
  });
}

// NHS hospitals (all England): `,Name,Latitude,Longitude`. Plain WGS84; clip to
// the London bounding box so we only render the local set.
function parseHospitals(csv: string): EmergencyService[] {
  const lines = splitLines(csv);
  return lines.slice(1).flatMap((line, index): EmergencyService[] => {
    const cols = parseCsvLine(line);
    const lat = parseNumber(cols[2]);
    const lng = parseNumber(cols[3]);
    if (lat === null || lng === null) return [];
    const corrected = correctHospitalLatLng(lat, lng);
    if (!isInLondon(corrected.lat, corrected.lng)) return [];
    return [
      {
        id: `hospital-${slug(cols[1] ?? '', String(index))}`,
        type: 'hospital',
        name: (cols[1] ?? 'Hospital').trim(),
        lat: corrected.lat,
        lng: corrected.lng,
      },
    ];
  });
}

function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function parseEmergencyServices(): EmergencyServicesPayload {
  const police = readIfExists(POLICE_PATH);
  const fire = readIfExists(FIRE_PATH);
  const hospitals = readIfExists(HOSPITAL_PATH);

  const services: EmergencyService[] = [
    ...(police ? parsePolice(police) : []),
    ...(fire ? parseFire(fire) : []),
    ...(hospitals ? parseHospitals(hospitals) : []),
  ];

  const counts = services.reduce(
    (acc, service) => {
      acc[service.type] += 1;
      return acc;
    },
    { police: 0, fire: 0, hospital: 0 } as Record<EmergencyServiceType, number>
  );

  return { services, counts };
}

let cachedPayload: EmergencyServicesPayload | null = null;

export function loadEmergencyServices(): EmergencyServicesPayload {
  if (!cachedPayload) {
    cachedPayload = parseEmergencyServices();
  }
  return cachedPayload;
}

/**
 * Emergency-services points of interest rendered as colour-coded icon markers on
 * the Cesium map: police stations (blue), hospitals (pink), fire stations (red).
 *
 * Each source dataset has a different shape and coordinate system — see
 * `lib/data/emergencyServices.ts` for parsing and `lib/geo/datasetCoordinates.ts`
 * for the per-dataset WGS84 corrections. All coordinates on this type are WGS84.
 */
export type EmergencyServiceType = 'police' | 'fire' | 'hospital';

export interface EmergencyService {
  id: string;
  type: EmergencyServiceType;
  name: string;
  lat: number;
  lng: number;
  /** Borough / local authority, where the dataset provides one. */
  borough?: string;
  /** Street address, where the dataset provides one (fire stations). */
  address?: string;
  /**
   * Operational status, where the dataset provides one. Police closures carry
   * `keep` / `cut`; other layers leave this undefined.
   */
  status?: string;
}

export interface EmergencyServicesPayload {
  services: EmergencyService[];
  counts: Record<EmergencyServiceType, number>;
}

import * as Cesium from 'cesium';
import type { EmergencyServiceType } from '@/types/emergency';

/**
 * Per-service marker styling: the dot colour and the pin icon. Colours match the
 * white-emblem map pins in `public/icons/*.svg` — blue police, pink hospital,
 * red fire — and double as the colour of the capping dot drawn under each pin.
 */
const SERVICE_COLORS: Record<EmergencyServiceType, string> = {
  police: '#2b6fff',
  hospital: '#ff4d9d',
  fire: '#ff3b30',
};

const SERVICE_ICONS: Record<EmergencyServiceType, string> = {
  police: '/icons/police.svg',
  hospital: '/icons/hospital.svg',
  fire: '/icons/fire.svg',
};

const SERVICE_LABELS: Record<EmergencyServiceType, string> = {
  police: 'Police',
  hospital: 'Hospital',
  fire: 'Fire',
};

export function getServiceColorCss(type: EmergencyServiceType): string {
  return SERVICE_COLORS[type];
}

export function getServiceColor(type: EmergencyServiceType, alpha = 1): Cesium.Color {
  return Cesium.Color.fromCssColorString(SERVICE_COLORS[type]).withAlpha(alpha);
}

export function getServiceIcon(type: EmergencyServiceType): string {
  return SERVICE_ICONS[type];
}

export function getServiceLabel(type: EmergencyServiceType): string {
  return SERVICE_LABELS[type];
}

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import EmergencyServicesLayer from './EmergencyServicesLayer';
import type {
  EmergencyService,
  EmergencyServicesPayload,
  EmergencyServiceType,
} from '@/types/emergency';

const DEFAULT_ACTIVE_TYPES: EmergencyServiceType[] = ['police', 'fire', 'hospital'];

interface EmergencyServicesProps {
  /** Service types to render. Defaults to all three. */
  activeTypes?: EmergencyServiceType[];
  /** Fired when a marker is picked (or the selection is cleared). */
  onSelectService?: (service: EmergencyService | null) => void;
}

/**
 * Self-contained emergency-services feature: fetches police / fire / hospital
 * points from `/api/emergency-services`, holds the local selection, and mounts
 * the colour-coded icon `EmergencyServicesLayer`. Must render inside
 * `<CesiumViewer>` so the layer can read the viewer from `CesiumContext`.
 *
 * Like `SitefinderTowers`, it never touches the Zustand store, so it drops into
 * any Cesium surface without breaking the swappable-map-seam invariant.
 */
export default function EmergencyServices({ activeTypes, onSelectService }: EmergencyServicesProps) {
  const [services, setServices] = useState<EmergencyService[]>([]);
  const [selected, setSelected] = useState<EmergencyService | null>(null);
  const active = useMemo(
    () => new Set(activeTypes ?? DEFAULT_ACTIVE_TYPES),
    [activeTypes]
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/emergency-services')
      .then((response) => {
        if (!response.ok) throw new Error(`Emergency-services request failed: ${response.status}`);
        return response.json() as Promise<EmergencyServicesPayload>;
      })
      .then((payload) => {
        if (!cancelled) setServices(payload.services);
      })
      .catch((error) => {
        console.error('Unable to load emergency-services dataset', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelect = useCallback(
    (service: EmergencyService | null) => {
      setSelected(service);
      onSelectService?.(service);
    },
    [onSelectService]
  );

  return (
    <EmergencyServicesLayer
      services={services}
      activeTypes={active}
      selectedId={selected?.id ?? null}
      onSelectService={handleSelect}
    />
  );
}

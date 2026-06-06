'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import SitefinderTowerLayer from './SitefinderTowerLayer';
import { useSitefinderSelection } from '@/hooks/useSitefinderSelection';
import type { SitefinderPayload, SitefinderTowerSite, TransmissionType } from '@/types/sitefinder';

const DEFAULT_ACTIVE_TYPES: TransmissionType[] = ['GSM', 'UMTS', 'TETRA', 'GSM-R', 'LTE'];

interface SitefinderTowersProps {
  /**
   * Fired when a tower is picked (or the selection is cleared). The host scene
   * uses this to fly its camera controller to the chosen site.
   */
  onSelectSite?: (site: SitefinderTowerSite | null) => void;
}

/**
 * Self-contained Sitefinder tower feature: fetches the dataset from
 * `/api/sitefinder`, holds the (local) selection, and mounts the 3D
 * antenna/tower `SitefinderTowerLayer`. Must be rendered inside `<CesiumViewer>`
 * so the layer can read the viewer from `CesiumContext`.
 *
 * Deliberately self-contained — it never touches the Zustand store, so it can
 * drop into any Cesium surface (the `/map` route's `CesiumMapWrapper` or the
 * dashboard's `CesiumScene`) without breaking the swappable-map-seam invariant.
 */
export default function SitefinderTowers({ onSelectSite }: SitefinderTowersProps) {
  const [sitefinder, setSitefinder] = useState<SitefinderPayload | null>(null);
  const { selectedSite, setSelectedSite } = useSitefinderSelection();
  const activeTypes = useMemo(() => new Set(DEFAULT_ACTIVE_TYPES), []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/sitefinder')
      .then((response) => {
        if (!response.ok) throw new Error(`Sitefinder request failed: ${response.status}`);
        return response.json() as Promise<SitefinderPayload>;
      })
      .then((payload) => {
        if (!cancelled) setSitefinder(payload);
      })
      .catch((error) => {
        console.error('Unable to load Sitefinder dataset', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectSite = useCallback(
    (site: SitefinderTowerSite | null) => {
      setSelectedSite(site);
      onSelectSite?.(site);
    },
    [onSelectSite, setSelectedSite]
  );

  return (
    <SitefinderTowerLayer
      sites={sitefinder?.sites ?? []}
      activeTypes={activeTypes}
      selectedSiteId={selectedSite?.id ?? null}
      onSelectSite={handleSelectSite}
    />
  );
}

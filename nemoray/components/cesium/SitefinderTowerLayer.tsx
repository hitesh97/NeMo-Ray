'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useCesiumViewer } from './CesiumContext';
import type { SitefinderTowerSite, TransmissionType } from '@/types/sitefinder';
import {
  getSitePrimaryColor,
  getSiteModelType,
  getSiteVisualHeight,
} from '@/lib/cesium/sitefinderVisuals';

interface SitefinderTowerLayerProps {
  sites: SitefinderTowerSite[];
  activeTypes: Set<TransmissionType>;
  selectedSiteId?: string | null;
  onSelectSite: (site: SitefinderTowerSite | null) => void;
  maxDetailedSites?: number;
}

interface SitefinderPickId {
  layer: 'sitefinder';
  siteId: string;
}

// Show 3D towers when camera is below this altitude
const DETAIL_CAMERA_HEIGHT_METERS = 8000;
const MIN_DETAIL_DISTANCE_METERS = 5600;
const DETAIL_DISTANCE_MULTIPLIER = 2.4;
const CAMERA_UPDATE_MS = 220;
// Fixed display distance for tower entities — avoids recomputing per-camera-move
const TOWER_MAX_DISPLAY_DISTANCE = 16000;

// London ground sits ~tens of metres above the WGS84 ellipsoid (geoid undulation
// ≈ +46 m). If terrain sampling hasn't resolved yet we must NOT anchor to 0 —
// that drops the model ~45 m below the photorealistic tiles, hiding it and
// leaving only the depth-disabled dots visible. Use this provisional ground
// height until the real tile surface is known, and keep re-sampling.
const LONDON_GROUND_FALLBACK_M = 46;
// How long to wait before re-sampling sites whose tiles weren't streamed in yet.
const TERRAIN_RESAMPLE_MS = 600;
// Stop re-sampling after this many consecutive no-progress passes.
const MAX_TERRAIN_RESAMPLES = 8;

const SELECTED_OUTLINE = Cesium.Color.fromCssColorString('#ffe34d').withAlpha(1);
const ACTIVE_OUTLINE = Cesium.Color.fromCssColorString('#ff9c33').withAlpha(0.96);

// GLTF model URIs (served from public/)
const RADIO_TOWER_URI = '/models/radio_tower/scene.gltf';
const CELL_TOWER_URI = '/models/cell_tower/scene.gltf';

// Native world-space Y extents (1 GLTF unit = 1 Cesium metre unless noted).
// scale = targetMetres / yRange; groundOffset = abs(yMin) * scale
const RADIO_TOWER_NATIVE_Y_RANGE = 12730; // Sketchfab FBX, 1 unit ≈ 1 cm. Y: -5089..7641
const RADIO_TOWER_NATIVE_Y_MIN = -5089;
const CELL_TOWER_NATIVE_Y_RANGE = 100.4;  // Y: 0..100.4 m after translation fix
const CELL_TOWER_NATIVE_Y_MIN = 0;

// Three rooftop antenna variants (antenna_a/b/c). Single-node, no transforms —
// native Y extents taken directly from GLTF accessors (units = metres).
const ROOFTOP_MODELS = [
  { uri: '/models/antenna_a/scene.gltf', yRange: 7.090, yMin: -3.545 },
  { uri: '/models/antenna_b/scene.gltf', yRange: 4.744, yMin: -3.258 },
  { uri: '/models/antenna_c/scene.gltf', yRange: 8.429, yMin: -3.545 },
] as const;

function rooftopModelForSite(site: SitefinderTowerSite): typeof ROOFTOP_MODELS[number] {
  let h = 0;
  for (let i = 0; i < site.id.length; i++) {
    h = (h * 31 + site.id.charCodeAt(i)) >>> 0;
  }
  return ROOFTOP_MODELS[h % ROOFTOP_MODELS.length];
}

function modelUriForSite(site: SitefinderTowerSite): string {
  const t = getSiteModelType(site);
  if (t === 'radio') return RADIO_TOWER_URI;
  if (t === 'rooftop') return rooftopModelForSite(site).uri;
  return CELL_TOWER_URI;
}

function modelScaleForSite(site: SitefinderTowerSite, targetHeightMeters: number): number {
  const t = getSiteModelType(site);
  if (t === 'radio') return targetHeightMeters / RADIO_TOWER_NATIVE_Y_RANGE;
  if (t === 'rooftop') return targetHeightMeters / rooftopModelForSite(site).yRange;
  return targetHeightMeters / CELL_TOWER_NATIVE_Y_RANGE;
}

// How far above ground to place the model entity so its base sits at ground level.
function modelGroundOffsetMeters(site: SitefinderTowerSite, scale: number): number {
  const t = getSiteModelType(site);
  if (t === 'radio') return Math.abs(RADIO_TOWER_NATIVE_Y_MIN) * scale;
  if (t === 'rooftop') return Math.abs(rooftopModelForSite(site).yMin) * scale;
  return CELL_TOWER_NATIVE_Y_MIN * scale;
}

const TOWER_DIST = new Cesium.DistanceDisplayCondition(0, TOWER_MAX_DISPLAY_DISTANCE);

function siteMatchesTypes(site: SitefinderTowerSite, activeTypes: Set<TransmissionType>): boolean {
  return site.transmissionTypes.some((type) => activeTypes.has(type));
}

function getDetailDistanceMeters(cameraHeightMeters: number): number {
  return Math.max(MIN_DETAIL_DISTANCE_METERS, cameraHeightMeters * DETAIL_DISTANCE_MULTIPLIER);
}

function isSiteInRectangle(site: SitefinderTowerSite, rectangle: Cesium.Rectangle | undefined): boolean {
  if (!rectangle) return true;
  const lng = Cesium.Math.toRadians(site.lng);
  const lat = Cesium.Math.toRadians(site.lat);
  const pad = Cesium.Math.toRadians(0.015);
  return (
    lng >= rectangle.west - pad &&
    lng <= rectangle.east + pad &&
    lat >= rectangle.south - pad &&
    lat <= rectangle.north + pad
  );
}

interface SitefinderPickedFeature {
  primitive?: { id?: SitefinderPickId };
  id?: {
    properties?: {
      sitefinderSiteId?: Cesium.Property;
    };
  };
}

function getPickedSiteId(picked: SitefinderPickedFeature | undefined): string | undefined {
  const primitiveId = picked?.primitive?.id;
  if (primitiveId?.layer === 'sitefinder') return primitiveId.siteId;
  const entity = picked?.id;
  const property = entity?.properties?.sitefinderSiteId;
  const propertyValue = typeof property?.getValue === 'function' ? property.getValue(Cesium.JulianDate.now()) : undefined;
  return typeof propertyValue === 'string' ? propertyValue : undefined;
}

function siteProps(site: SitefinderTowerSite) {
  return { sitefinderSiteId: site.id };
}


function buildTowerEntities(
  viewer: Cesium.Viewer,
  site: SitefinderTowerSite,
  isSelected: boolean,
  groundHeight: number
): Cesium.Entity[] {
  const entities: Cesium.Entity[] = [];
  const isRooftop = getSiteModelType(site) === 'rooftop';
  const towerHeight = isRooftop
    ? Math.max(6, getSiteVisualHeight(site))
    : Math.max(32, getSiteVisualHeight(site));
  const g = groundHeight;
  const props = siteProps(site);
  const dd = TOWER_DIST;

  // GLTF model — replaces procedural spine/legs/arms/cabinet
  const scale = modelScaleForSite(site, towerHeight);
  const groundOffset = modelGroundOffsetMeters(site, scale);
  const modelPos = Cesium.Cartesian3.fromDegrees(site.lng, site.lat, g + groundOffset);
  entities.push(
    viewer.entities.add({
      properties: props,
      position: modelPos,
      model: {
        uri: modelUriForSite(site),
        scale,
        minimumPixelSize: 48,
        maximumScale: 500,
        distanceDisplayCondition: dd,
        silhouetteColor: isSelected ? SELECTED_OUTLINE : Cesium.Color.TRANSPARENT,
        silhouetteSize: isSelected ? 3.5 : 0,
      },
    })
  );

  return entities;
}

// Resolve the photorealistic-tile surface height under each site. Returns ONLY
// the heights that resolved to a real surface — sites whose tiles hadn't
// streamed in yet are omitted (not set to 0), so the caller re-samples them
// rather than caching a bad value that buries the model underground.
async function sampleSiteHeights(
  viewer: Cesium.Viewer,
  sites: SitefinderTowerSite[],
  // Exclude our own tower entities so a previously-placed (fallback-height)
  // model can't be clamped/sampled onto instead of the actual tile surface.
  exclude: object[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (sites.length === 0) return result;

  const isValid = (h: number | undefined): h is number =>
    typeof h === 'number' && Number.isFinite(h) && Math.abs(h) > 1e-3;

  try {
    // clampToHeightMostDetailed is the 3D-Tiles-aware API — it loads the most
    // detailed tiles at each point first, so it reads the real Google city
    // surface rather than the (disabled) globe.
    if (viewer.scene.clampToHeightSupported) {
      const positions = sites.map((s) => Cesium.Cartesian3.fromDegrees(s.lng, s.lat, 0));
      const clamped = await viewer.scene.clampToHeightMostDetailed(positions, exclude);
      sites.forEach((s, i) => {
        const c = clamped[i];
        if (!Cesium.defined(c)) return;
        const h = Cesium.Cartographic.fromCartesian(c).height;
        if (isValid(h)) result.set(s.id, h);
      });
      return result;
    }

    if (viewer.scene.sampleHeightSupported) {
      const carts = sites.map((s) => Cesium.Cartographic.fromDegrees(s.lng, s.lat));
      const sampled = await viewer.scene.sampleHeightMostDetailed(carts, exclude);
      sites.forEach((s, i) => {
        const h = sampled[i]?.height;
        if (isValid(h)) result.set(s.id, h);
      });
    }
  } catch {
    // Leave unresolved sites out — the caller retries on the next pass.
  }
  return result;
}

export default function SitefinderTowerLayer({
  sites,
  activeTypes,
  selectedSiteId,
  onSelectSite,
  maxDetailedSites = 48,
}: SitefinderTowerLayerProps): null {
  const viewer = useCesiumViewer();
  const pointCollectionRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const entitiesRef = useRef<Cesium.Entity[]>([]);
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null);
  const siteLookupRef = useRef(new Map<string, SitefinderTowerSite>());
  const visibleSitesRef = useRef<SitefinderTowerSite[]>([]);
  // Cache of resolved tile-surface heights. Only *valid* heights are stored —
  // sites whose tiles weren't streamed in yet stay absent so they re-sample.
  const terrainCacheRef = useRef(new Map<string, number>());
  const [detailedSiteIds, setDetailedSiteIds] = useState<string[]>([]);
  // Bumped whenever new terrain heights resolve: drives the dot layer to re-anchor
  // to the ground and schedules a re-sample for any still-unresolved sites.
  const [terrainVersion, setTerrainVersion] = useState(0);
  // Caps re-sampling so a site that never resolves can't poll forever.
  const resampleAttemptsRef = useRef(0);

  const visibleSites = useMemo(
    () => sites.filter((site) => siteMatchesTypes(site, activeTypes)),
    [sites, activeTypes]
  );

  useEffect(() => {
    siteLookupRef.current = new Map(visibleSites.map((s) => [s.id, s]));
    visibleSitesRef.current = visibleSites;
  }, [visibleSites]);

  const refreshDetailedSites = useCallback(() => {
    if (!viewer) return;
    const { height } = viewer.camera.positionCartographic;
    if (height > DETAIL_CAMERA_HEIGHT_METERS) {
      setDetailedSiteIds((c) => (c.length === 0 ? c : []));
      return;
    }
    const detailDist = getDetailDistanceMeters(height);
    const rect = viewer.camera.computeViewRectangle(Cesium.Ellipsoid.WGS84);
    const camPos = viewer.camera.positionWC;
    const next = visibleSitesRef.current
      .filter((s) => isSiteInRectangle(s, rect))
      .map((s) => ({
        s,
        d: Cesium.Cartesian3.distance(camPos, Cesium.Cartesian3.fromDegrees(s.lng, s.lat, 40)),
      }))
      .filter(({ d }) => d <= detailDist)
      .sort((a, b) => a.d - b.d)
      .slice(0, maxDetailedSites)
      .map(({ s }) => s.id);

    setDetailedSiteIds((c) =>
      c.length === next.length && c.every((id, i) => id === next[i]) ? c : next
    );
  }, [maxDetailedSites, viewer]);

  useEffect(() => {
    const t = setTimeout(refreshDetailedSites, 0);
    return () => clearTimeout(t);
  }, [refreshDetailedSites, visibleSites, selectedSiteId]);

  useEffect(() => {
    if (!viewer) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const unsub = viewer.camera.changed.addEventListener(() => {
      if (timeout) return;
      timeout = setTimeout(() => {
        timeout = null;
        refreshDetailedSites();
      }, CAMERA_UPDATE_MS);
    });
    return () => {
      unsub();
      if (timeout) clearTimeout(timeout);
    };
  }, [refreshDetailedSites, viewer]);

  // Points — always visible, never depth-clipped
  useEffect(() => {
    if (!viewer) return;
    if (pointCollectionRef.current) {
      viewer.scene.primitives.remove(pointCollectionRef.current);
      pointCollectionRef.current = null;
    }
    const pts = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(pts);
    pointCollectionRef.current = pts;

    visibleSites.forEach((site) => {
      const sel = selectedSiteId === site.id;
      // Anchor the dot to its site's resolved tile-surface height so it sits at
      // the antenna's base (same lng/lat AND same ground), keeping the marker and
      // the model in sync and clicks accurate. Fall back to the London ground
      // height until that site's terrain has been sampled.
      const groundHeight = terrainCacheRef.current.get(site.id) ?? LONDON_GROUND_FALLBACK_M;
      pts.add({
        id: { layer: 'sitefinder', siteId: site.id } satisfies SitefinderPickId,
        position: Cesium.Cartesian3.fromDegrees(site.lng, site.lat, groundHeight),
        color: getSitePrimaryColor(site, sel ? 1 : 0.86),
        outlineColor: sel ? SELECTED_OUTLINE : ACTIVE_OUTLINE,
        outlineWidth: sel ? 5 : 2,
        pixelSize: sel ? 14 : 6,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, Number.MAX_VALUE),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    });

    return () => {
      if (pointCollectionRef.current && !viewer.isDestroyed()) {
        viewer.scene.primitives.remove(pointCollectionRef.current);
        pointCollectionRef.current = null;
      }
    };
  }, [selectedSiteId, viewer, visibleSites, terrainVersion]);

  useEffect(() => {
    if (!viewer) return;
    if (handlerRef.current) { handlerRef.current.destroy(); handlerRef.current = null; }
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(click.position);
      const siteId = getPickedSiteId(picked);
      onSelectSite(siteId ? siteLookupRef.current.get(siteId) ?? null : null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handlerRef.current = handler;
    return () => { if (handlerRef.current) { handlerRef.current.destroy(); handlerRef.current = null; } };
  }, [onSelectSite, viewer]);

  // 3D tower entities — swap pattern: new entities added before old ones removed, so no gap
  useEffect(() => {
    if (!viewer) return;

    const detailedSites = detailedSiteIds
      .map((id) => siteLookupRef.current.get(id))
      .filter((s): s is SitefinderTowerSite => Boolean(s));

    if (detailedSites.length === 0) {
      const prev = entitiesRef.current;
      entitiesRef.current = [];
      if (!viewer.isDestroyed()) prev.forEach((e) => viewer.entities.remove(e));
      return;
    }

    let active = true;

    const build = (cache: Map<string, number>) => {
      if (!active) return;

      const fresh: Cesium.Entity[] = [];
      detailedSites.forEach((site) => {
        // Unresolved sites render at the London ground fallback (never 0, which
        // would bury them ~45 m under the tiles) until their tiles stream in.
        const groundHeight = cache.get(site.id) ?? LONDON_GROUND_FALLBACK_M;
        fresh.push(...buildTowerEntities(viewer, site, selectedSiteId === site.id, groundHeight));
      });

      if (!active) {
        // Cancelled between building and swapping — remove the freshly added entities
        if (!viewer.isDestroyed()) fresh.forEach((e) => viewer.entities.remove(e));
        return;
      }

      // Swap: old entities stay visible until this point, so there's no empty frame
      const prev = entitiesRef.current;
      entitiesRef.current = fresh;
      if (!viewer.isDestroyed()) prev.forEach((e) => viewer.entities.remove(e));
    };

    const uncached = detailedSites.filter((s) => !terrainCacheRef.current.has(s.id));

    let resampleTimer: ReturnType<typeof setTimeout> | null = null;

    if (uncached.length === 0) {
      // All terrain heights already known — build synchronously, no async gap
      resampleAttemptsRef.current = 0;
      build(terrainCacheRef.current);
    } else {
      (async () => {
        const newHeights = await sampleSiteHeights(viewer, uncached, entitiesRef.current);
        if (!active) return;
        newHeights.forEach((h, id) => terrainCacheRef.current.set(id, h));
        build(terrainCacheRef.current);

        // Sites still missing a height (tiles not streamed in yet) were rendered
        // at the fallback. Bump the version so the dot layer re-anchors any that
        // did resolve, and re-run shortly to snap the stragglers onto the tiles —
        // capped so a permanently-unresolvable site can't poll forever.
        if (newHeights.size > 0) {
          resampleAttemptsRef.current = 0;
          setTerrainVersion((v) => v + 1);
        }
        if (newHeights.size < uncached.length && resampleAttemptsRef.current < MAX_TERRAIN_RESAMPLES) {
          resampleAttemptsRef.current += 1;
          resampleTimer = setTimeout(() => {
            if (active) setTerrainVersion((v) => v + 1);
          }, TERRAIN_RESAMPLE_MS);
        }
      })();
    }

    return () => {
      // Mark cancelled so any in-flight async skips the swap.
      // Do NOT remove entitiesRef.current here — the next effect run will swap them out
      // without leaving an empty frame. The viewer-level cleanup effect handles unmount.
      active = false;
      if (resampleTimer) clearTimeout(resampleTimer);
    };
  }, [detailedSiteIds, selectedSiteId, viewer, terrainVersion]);

  // Final cleanup when viewer goes away (component unmount or viewer destroyed)
  useEffect(() => {
    if (!viewer) return;
    return () => {
      if (viewer.isDestroyed()) return;
      entitiesRef.current.forEach((e) => viewer.entities.remove(e));
      entitiesRef.current = [];
      if (pointCollectionRef.current) {
        viewer.scene.primitives.remove(pointCollectionRef.current);
        pointCollectionRef.current = null;
      }
      if (handlerRef.current) {
        handlerRef.current.destroy();
        handlerRef.current = null;
      }
    };
  }, [viewer]);

  return null;
}

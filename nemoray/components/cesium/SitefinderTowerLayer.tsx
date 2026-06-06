'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useCesiumViewer } from './CesiumContext';
import type { SitefinderTowerSite, TransmissionType } from '@/types/sitefinder';
import { getSitePrimaryColor, getSiteVisualHeight } from '@/lib/cesium/sitefinderVisuals';

interface SitefinderTowerLayerProps {
  sites: SitefinderTowerSite[];
  activeTypes: Set<TransmissionType>;
  selectedSiteId?: string | null;
  onSelectSite: (site: SitefinderTowerSite | null) => void;
}

interface SitefinderPickId {
  layer: 'sitefinder';
  siteId: string;
}

// Build full 3D towers only near the camera — thousands of lattice towers at
// once would be heavy and cluttered. The capping dots follow the same proximity
// set, so a dot only appears where its tower does.
const DETAIL_CAMERA_HEIGHT_METERS = 8000;
const MIN_DETAIL_DISTANCE_METERS = 5600;
const DETAIL_DISTANCE_MULTIPLIER = 2.4;
const MAX_DETAILED_SITES = 60;
const CAMERA_UPDATE_MS = 220;

// London ground sits ~tens of metres above the WGS84 ellipsoid (geoid undulation
// ≈ +46 m). Anchoring at 0 — or at any fixed value below the real tile surface —
// drops the tower base metres underground, so we sample the actual surface and
// only use this provisional height until that resolves.
const LONDON_GROUND_FALLBACK_M = 46;
const TERRAIN_RESAMPLE_MS = 600;
const MAX_TERRAIN_RESAMPLES = 8;

const SELECTED_OUTLINE = Cesium.Color.fromCssColorString('#ffe34d').withAlpha(1);
const ACTIVE_OUTLINE = Cesium.Color.fromCssColorString('#ff9c33').withAlpha(0.96);

// Dots cap each detailed tower at its tip — small, dim markers rather than the
// bright always-on beacons they used to be. Trivial starting values; tune by eye.
const DOT_PIXEL_SIZE = 5;
const DOT_SELECTED_PIXEL_SIZE = 8;
const DOT_ALPHA = 0.9;
const DOT_SELECTED_ALPHA = 1;
const DOT_OUTLINE_WIDTH = 1;
const DOT_SELECTED_OUTLINE_WIDTH = 2;

// Neon-lattice glow colours; selected towers glow yellow to match the dot's ring.
const RED_GLOW_COLOR = Cesium.Color.fromCssColorString('#ff3838');
const SELECTED_GLOW_COLOR = Cesium.Color.fromCssColorString('#ffd24a');

// Each polyline MUST own a fresh Material instance — Cesium's `Polyline._destroy`
// destroys its `_material`, and `PolylineCollection` tears down every polyline
// with no dedup. A Material shared across segments would get destroyed once by the
// first polyline, then re-destroyed by the next → "This object was destroyed".
// Distinct instances with identical uniforms still batch into one draw call
// (PolylineCollection buckets by material *content*), so this costs nothing to render.
function makeGlowMaterial(isSelected: boolean): Cesium.Material {
  return Cesium.Material.fromType('PolylineGlow', {
    color: isSelected ? SELECTED_GLOW_COLOR : RED_GLOW_COLOR,
    glowPower: isSelected ? 0.34 : 0.22,
    taperPower: 1,
  });
}

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
}

function getPickedSiteId(picked: SitefinderPickedFeature | undefined): string | undefined {
  const primitiveId = picked?.primitive?.id;
  if (primitiveId?.layer === 'sitefinder') return primitiveId.siteId;
  return undefined;
}

// Ellipsoid height of the antenna tip — where the spire ends in buildLatticeTower
// — so the capping dot sits exactly on top of the tower.
function getTowerTopHeight(site: SitefinderTowerSite, groundHeight: number): number {
  const height = Math.max(14, getSiteVisualHeight(site));
  return groundHeight + height + Math.max(3, height * 0.14);
}

/**
 * Build a 3D red lattice tower as world-space polylines, standing along the
 * local surface normal (ENU up) like a building. A tapered square lattice — four
 * legs with horizontal rungs and X-bracing — plus a spire. Base sits on the
 * sampled tile surface (`groundHeight`); the height comes from the CSV antenna
 * height. Every segment carries the site id so picks resolve.
 */
function buildLatticeTower(
  site: SitefinderTowerSite,
  groundHeight: number,
  isSelected: boolean,
  collection: Cesium.PolylineCollection
): void {
  const height = Math.max(14, getSiteVisualHeight(site)); // metres
  const baseHalf = Cesium.Math.clamp(height * 0.09, 3, 9); // slender, like a real mast
  const topHalf = baseHalf * 0.32;
  // Fresh material per segment — see makeGlowMaterial's note on per-polyline ownership.
  const width = isSelected ? 3.6 : 2.2;
  const id: SitefinderPickId = { layer: 'sitefinder', siteId: site.id };

  // Local East-North-Up frame at the tower's base → up axis = surface normal.
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(site.lng, site.lat, groundHeight)
  );
  const toWorld = (x: number, y: number, z: number): Cesium.Cartesian3 =>
    Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());

  // Four corners (square cross-section), tapering from baseHalf to topHalf.
  const signs: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const corner = (i: number, t: number): Cesium.Cartesian3 => {
    const [sx, sy] = signs[i];
    const half = baseHalf + (topHalf - baseHalf) * t;
    return toWorld(sx * half, sy * half, height * t);
  };

  // Legs
  for (let i = 0; i < 4; i++) {
    collection.add({ positions: [corner(i, 0), corner(i, 1)], width, material: makeGlowMaterial(isSelected), id });
  }

  // Rungs (closed square loops) + X-bracing on each face between levels.
  const levels = Math.max(3, Math.round(height / 12));
  for (let l = 0; l <= levels; l++) {
    const t = l / levels;
    const ring = [corner(0, t), corner(1, t), corner(2, t), corner(3, t)];
    collection.add({ positions: [...ring, ring[0]], width: width * 0.7, material: makeGlowMaterial(isSelected), id });
    if (l < levels) {
      const t1 = (l + 1) / levels;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        collection.add({ positions: [corner(i, t), corner(j, t1)], width: width * 0.55, material: makeGlowMaterial(isSelected), id });
      }
    }
  }

  // Spire above the lattice head.
  collection.add({
    positions: [toWorld(0, 0, height), toWorld(0, 0, height + Math.max(3, height * 0.14))],
    width,
    material: makeGlowMaterial(isSelected),
    id,
  });
}

// Resolve the photorealistic-tile surface height under each site. Returns ONLY
// the heights that resolved — sites whose tiles hadn't streamed in yet are
// omitted (not set to 0/fallback) so the caller re-samples rather than caching a
// bad value that buries the tower base underground.
async function sampleSiteHeights(
  viewer: Cesium.Viewer,
  sites: SitefinderTowerSite[],
  exclude: object[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (sites.length === 0) return result;

  const isValid = (h: number | undefined): h is number =>
    typeof h === 'number' && Number.isFinite(h) && Math.abs(h) > 1e-3;

  try {
    // clampToHeightMostDetailed is the 3D-Tiles-aware API — it streams in the
    // most detailed tiles at each point first, reading the real city surface.
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

// Detach a primitive collection from the scene, tolerant of it having already
// been destroyed out from under us (Fast Refresh / viewer teardown can destroy
// primitives while their refs are still live). A plain `primitives.remove()`
// would call `destroy()` on the already-dead collection → "This object was
// destroyed". Worse, *skipping* the remove leaves a destroyed primitive parented
// in the scene, so the next render tick calls `.update()` on it and crashes
// `CesiumWidget._onTick`. So when it's already destroyed we detach WITHOUT
// re-destroying (toggle `destroyPrimitives`), otherwise remove-and-destroy as
// usual to free the GPU resources.
function detachPrimitive(
  viewer: Cesium.Viewer,
  primitive: Cesium.PolylineCollection | Cesium.PointPrimitiveCollection | null
): void {
  if (!primitive || viewer.isDestroyed()) return;
  const primitives = viewer.scene.primitives;
  if (!primitives.contains(primitive)) return;
  if (primitive.isDestroyed()) {
    const keep = primitives.destroyPrimitives;
    primitives.destroyPrimitives = false;
    primitives.remove(primitive);
    primitives.destroyPrimitives = keep;
  } else {
    primitives.remove(primitive);
  }
}

export default function SitefinderTowerLayer({
  sites,
  activeTypes,
  selectedSiteId,
  onSelectSite,
}: SitefinderTowerLayerProps): null {
  const viewer = useCesiumViewer();
  const pointCollectionRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const towerCollectionRef = useRef<Cesium.PolylineCollection | null>(null);
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null);
  const siteLookupRef = useRef(new Map<string, SitefinderTowerSite>());
  const visibleSitesRef = useRef<SitefinderTowerSite[]>([]);
  // Cache of resolved tile-surface heights — only valid heights are stored.
  const terrainCacheRef = useRef(new Map<string, number>());
  const [detailedSiteIds, setDetailedSiteIds] = useState<string[]>([]);
  const [terrainVersion, setTerrainVersion] = useState(0);
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
      .slice(0, MAX_DETAILED_SITES)
      .map(({ s }) => s.id);

    setDetailedSiteIds((c) =>
      c.length === next.length && c.every((id, i) => id === next[i]) ? c : next
    );
  }, [viewer]);

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

  // Dots — proximity-based like the towers: one small dot capping each detailed
  // tower's tip. Never depth-clipped so the cap stays visible against the lattice.
  useEffect(() => {
    if (!viewer) return;
    detachPrimitive(viewer, pointCollectionRef.current);
    pointCollectionRef.current = null;
    const pts = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(pts);
    pointCollectionRef.current = pts;

    const detailedSites = detailedSiteIds
      .map((id) => siteLookupRef.current.get(id))
      .filter((s): s is SitefinderTowerSite => Boolean(s));

    detailedSites.forEach((site) => {
      const sel = selectedSiteId === site.id;
      const groundHeight = terrainCacheRef.current.get(site.id) ?? LONDON_GROUND_FALLBACK_M;
      pts.add({
        id: { layer: 'sitefinder', siteId: site.id } satisfies SitefinderPickId,
        position: Cesium.Cartesian3.fromDegrees(site.lng, site.lat, getTowerTopHeight(site, groundHeight)),
        color: getSitePrimaryColor(site, sel ? DOT_SELECTED_ALPHA : DOT_ALPHA),
        outlineColor: sel ? SELECTED_OUTLINE : ACTIVE_OUTLINE,
        outlineWidth: sel ? DOT_SELECTED_OUTLINE_WIDTH : DOT_OUTLINE_WIDTH,
        pixelSize: sel ? DOT_SELECTED_PIXEL_SIZE : DOT_PIXEL_SIZE,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, Number.MAX_VALUE),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    });

    return () => {
      detachPrimitive(viewer, pointCollectionRef.current);
      pointCollectionRef.current = null;
    };
  }, [selectedSiteId, viewer, detailedSiteIds, terrainVersion]);

  // 3D lattice towers for the nearest sites — swap pattern: build the new
  // collection, add it, then remove the old one, so there's no empty frame.
  useEffect(() => {
    if (!viewer) return;

    const detailedSites = detailedSiteIds
      .map((id) => siteLookupRef.current.get(id))
      .filter((s): s is SitefinderTowerSite => Boolean(s));

    if (detailedSites.length === 0) {
      const prev = towerCollectionRef.current;
      towerCollectionRef.current = null;
      detachPrimitive(viewer, prev);
      return;
    }

    let active = true;
    let resampleTimer: ReturnType<typeof setTimeout> | null = null;

    const build = (cache: Map<string, number>) => {
      if (!active || viewer.isDestroyed()) return;
      const next = new Cesium.PolylineCollection();
      detailedSites.forEach((site) => {
        const groundHeight = cache.get(site.id) ?? LONDON_GROUND_FALLBACK_M;
        buildLatticeTower(site, groundHeight, selectedSiteId === site.id, next);
      });
      // The viewer can be torn down while building (async path awaits above);
      // bail and free the half-built collection rather than parent it to a dead scene.
      if (!active || viewer.isDestroyed()) {
        next.destroy();
        return;
      }
      viewer.scene.primitives.add(next);
      const prev = towerCollectionRef.current;
      towerCollectionRef.current = next;
      detachPrimitive(viewer, prev);
    };

    const uncached = detailedSites.filter((s) => !terrainCacheRef.current.has(s.id));

    if (uncached.length === 0) {
      resampleAttemptsRef.current = 0;
      build(terrainCacheRef.current);
    } else {
      (async () => {
        const exclude = towerCollectionRef.current ? [towerCollectionRef.current] : [];
        const newHeights = await sampleSiteHeights(viewer, uncached, exclude);
        if (!active) return;
        newHeights.forEach((h, id) => terrainCacheRef.current.set(id, h));
        build(terrainCacheRef.current);

        // Snap any stragglers (tiles not streamed in yet) once they resolve,
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
      active = false;
      if (resampleTimer) clearTimeout(resampleTimer);
    };
  }, [detailedSiteIds, selectedSiteId, viewer, terrainVersion]);

  // Click-to-select — picks the dot or any tower segment (all carry the site id)
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

  // Final cleanup when the viewer goes away (component unmount or viewer destroyed)
  useEffect(() => {
    if (!viewer) return;
    return () => {
      if (viewer.isDestroyed()) return;
      detachPrimitive(viewer, pointCollectionRef.current);
      pointCollectionRef.current = null;
      detachPrimitive(viewer, towerCollectionRef.current);
      towerCollectionRef.current = null;
      if (handlerRef.current) {
        handlerRef.current.destroy();
        handlerRef.current = null;
      }
    };
  }, [viewer]);

  return null;
}

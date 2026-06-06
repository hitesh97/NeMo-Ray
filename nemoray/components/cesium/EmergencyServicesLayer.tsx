'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useCesiumViewer } from './CesiumContext';
import type { EmergencyService, EmergencyServiceType } from '@/types/emergency';
import { getServiceColor, getServiceIcon, getServiceLabel } from '@/lib/cesium/emergencyVisuals';

interface EmergencyServicesLayerProps {
  services: EmergencyService[];
  /** Which service types to show; markers of other types are hidden. */
  activeTypes: Set<EmergencyServiceType>;
  selectedId?: string | null;
  onSelectService: (service: EmergencyService | null) => void;
}

interface EmergencyPickId {
  layer: 'emergency';
  serviceId: string;
}

// Proximity LOD — identical scheme to SitefinderTowerLayer: render markers only
// for the nearest sites in view, and only when the camera is low enough. Beyond
// that they're hidden, so the city isn't carpeted with icons when zoomed out.
const DETAIL_CAMERA_HEIGHT_METERS = 8000;
const MIN_DETAIL_DISTANCE_METERS = 5600;
const DETAIL_DISTANCE_MULTIPLIER = 2.4;
const MAX_DETAILED_SERVICES = 90;
const CAMERA_UPDATE_MS = 220;

// Markers plant on the globe ground (z = 0, the OSM twin's street-level frame) —
// no tile-surface sampling, matching SitefinderTowerLayer.
const GROUND_HEIGHT_M = 0;

// Markers are deliberately tiny — the dot is ~13% larger than the antenna dot
// (5 px), and the logo pin is shrunk right down so it reads as a small badge
// rather than a billboard.
const PIN_SCALE = 0.18;
const PIN_SELECTED_SCALE = 0.26;
const PIN_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(800, 1, 9000, 0.55);
const DOT_PIXEL_SIZE = 5.7;
const DOT_SELECTED_PIXEL_SIZE = 8;
const DOT_OUTLINE = Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.92);

function serviceMatchesTypes(service: EmergencyService, activeTypes: Set<EmergencyServiceType>): boolean {
  return activeTypes.has(service.type);
}

function getDetailDistanceMeters(cameraHeightMeters: number): number {
  return Math.max(MIN_DETAIL_DISTANCE_METERS, cameraHeightMeters * DETAIL_DISTANCE_MULTIPLIER);
}

function isServiceInRectangle(service: EmergencyService, rectangle: Cesium.Rectangle | undefined): boolean {
  if (!rectangle) return true;
  const lng = Cesium.Math.toRadians(service.lng);
  const lat = Cesium.Math.toRadians(service.lat);
  const pad = Cesium.Math.toRadians(0.015);
  return (
    lng >= rectangle.west - pad &&
    lng <= rectangle.east + pad &&
    lat >= rectangle.south - pad &&
    lat <= rectangle.north + pad
  );
}

interface EmergencyPickedFeature {
  primitive?: { id?: EmergencyPickId };
}

function getPickedServiceId(picked: EmergencyPickedFeature | undefined): string | undefined {
  const id = picked?.primitive?.id;
  return id?.layer === 'emergency' ? id.serviceId : undefined;
}

// Detach a primitive collection, tolerant of it already having been destroyed by
// Fast Refresh / viewer teardown (see the matching helper in SitefinderTowerLayer).
function detachPrimitive(
  viewer: Cesium.Viewer,
  primitive:
    | Cesium.BillboardCollection
    | Cesium.PointPrimitiveCollection
    | Cesium.LabelCollection
    | null
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

export default function EmergencyServicesLayer({
  services,
  activeTypes,
  selectedId,
  onSelectService,
}: EmergencyServicesLayerProps): null {
  const viewer = useCesiumViewer();
  const billboardsRef = useRef<Cesium.BillboardCollection | null>(null);
  const dotsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const labelsRef = useRef<Cesium.LabelCollection | null>(null);
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null);
  const serviceLookupRef = useRef(new Map<string, EmergencyService>());
  const visibleServicesRef = useRef<EmergencyService[]>([]);
  const [detailedServiceIds, setDetailedServiceIds] = useState<string[]>([]);

  const visibleServices = useMemo(
    () => services.filter((s) => serviceMatchesTypes(s, activeTypes)),
    [services, activeTypes]
  );

  useEffect(() => {
    serviceLookupRef.current = new Map(visibleServices.map((s) => [s.id, s]));
    visibleServicesRef.current = visibleServices;
  }, [visibleServices]);

  // Pick the nearest in-view services to render at the current camera height.
  const refreshDetailedServices = useCallback(() => {
    if (!viewer) return;
    const { height } = viewer.camera.positionCartographic;
    if (height > DETAIL_CAMERA_HEIGHT_METERS) {
      setDetailedServiceIds((c) => (c.length === 0 ? c : []));
      return;
    }
    const detailDist = getDetailDistanceMeters(height);
    const rect = viewer.camera.computeViewRectangle(Cesium.Ellipsoid.WGS84);
    const camPos = viewer.camera.positionWC;
    const next = visibleServicesRef.current
      .filter((s) => isServiceInRectangle(s, rect))
      .map((s) => ({
        s,
        d: Cesium.Cartesian3.distance(camPos, Cesium.Cartesian3.fromDegrees(s.lng, s.lat, 40)),
      }))
      .filter(({ d }) => d <= detailDist)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_DETAILED_SERVICES)
      .map(({ s }) => s.id);

    setDetailedServiceIds((c) =>
      c.length === next.length && c.every((id, i) => id === next[i]) ? c : next
    );
  }, [viewer]);

  useEffect(() => {
    const t = setTimeout(refreshDetailedServices, 0);
    return () => clearTimeout(t);
  }, [refreshDetailedServices, visibleServices, selectedId]);

  useEffect(() => {
    if (!viewer) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const unsub = viewer.camera.changed.addEventListener(() => {
      if (timeout) return;
      timeout = setTimeout(() => {
        timeout = null;
        refreshDetailedServices();
      }, CAMERA_UPDATE_MS);
    });
    return () => {
      unsub();
      if (timeout) clearTimeout(timeout);
    };
  }, [refreshDetailedServices, viewer]);

  // Build the pins, dots and (for the selected marker) a name label for the
  // proximity set. Swap pattern: build the new collections, add them, then drop
  // the old ones so there's never an empty frame.
  useEffect(() => {
    if (!viewer) return;

    const detailedServices = detailedServiceIds
      .map((id) => serviceLookupRef.current.get(id))
      .filter((s): s is EmergencyService => Boolean(s));

    const billboards = new Cesium.BillboardCollection({ scene: viewer.scene });
    const dots = new Cesium.PointPrimitiveCollection();
    const labels = new Cesium.LabelCollection({ scene: viewer.scene });

    detailedServices.forEach((service) => {
      const selected = selectedId === service.id;
      const position = Cesium.Cartesian3.fromDegrees(service.lng, service.lat, GROUND_HEIGHT_M);
      const id: EmergencyPickId = { layer: 'emergency', serviceId: service.id };

      // The capping colour dot, pinned to the exact ground point.
      dots.add({
        id,
        position,
        color: getServiceColor(service.type, 1),
        outlineColor: DOT_OUTLINE,
        outlineWidth: selected ? 2 : 1.5,
        pixelSize: selected ? DOT_SELECTED_PIXEL_SIZE : DOT_PIXEL_SIZE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });

      // The logo pin, standing on the dot (vertical origin BOTTOM = tip on ground).
      billboards.add({
        id,
        position,
        image: getServiceIcon(service.type),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        scale: selected ? PIN_SELECTED_SCALE : PIN_SCALE,
        scaleByDistance: PIN_SCALE_BY_DISTANCE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        eyeOffset: new Cesium.Cartesian3(0, 0, selected ? -20 : 0),
      });

      if (selected) {
        labels.add({
          id,
          position,
          text: `${getServiceLabel(service.type)} · ${service.name}`,
          font: '600 13px "Inter", system-ui, sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0a1424').withAlpha(0.88),
          backgroundPadding: new Cesium.Cartesian2(8, 5),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          pixelOffset: new Cesium.Cartesian2(0, -40),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    });

    viewer.scene.primitives.add(billboards);
    viewer.scene.primitives.add(dots);
    viewer.scene.primitives.add(labels);

    const prevBillboards = billboardsRef.current;
    const prevDots = dotsRef.current;
    const prevLabels = labelsRef.current;
    billboardsRef.current = billboards;
    dotsRef.current = dots;
    labelsRef.current = labels;
    detachPrimitive(viewer, prevBillboards);
    detachPrimitive(viewer, prevDots);
    detachPrimitive(viewer, prevLabels);
  }, [viewer, detailedServiceIds, selectedId]);

  // Click-to-select — picks the pin, the dot or the label (all carry the id).
  useEffect(() => {
    if (!viewer) return;
    if (handlerRef.current) {
      handlerRef.current.destroy();
      handlerRef.current = null;
    }
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(click.position);
      const serviceId = getPickedServiceId(picked);
      // Clear the selection when clicking anything that isn't one of our markers
      // (empty space, a tower, a building) so the label doesn't linger.
      onSelectService(serviceId ? serviceLookupRef.current.get(serviceId) ?? null : null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handlerRef.current = handler;
    return () => {
      if (handlerRef.current) {
        handlerRef.current.destroy();
        handlerRef.current = null;
      }
    };
  }, [onSelectService, viewer]);

  // Final cleanup when the viewer goes away.
  useEffect(() => {
    if (!viewer) return;
    return () => {
      if (viewer.isDestroyed()) return;
      detachPrimitive(viewer, billboardsRef.current);
      detachPrimitive(viewer, dotsRef.current);
      detachPrimitive(viewer, labelsRef.current);
      billboardsRef.current = null;
      dotsRef.current = null;
      labelsRef.current = null;
      if (handlerRef.current) {
        handlerRef.current.destroy();
        handlerRef.current = null;
      }
    };
  }, [viewer]);

  return null;
}

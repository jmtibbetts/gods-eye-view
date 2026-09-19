import * as Cesium from 'cesium';
import { imagingPlatformFor, swathKmFor } from './sensors.js';
import {
  FOOTPRINT_COLOR,
  FOOTPRINT_DISK_RADIUS_M,
  FOOTPRINT_REFRESH_MS,
  FOOTPRINT_TRAIL_SECONDS,
  FOOTPRINT_TRAIL_STEPS,
} from './policy.js';

/**
 * The ground an imaging satellite is sweeping — drawn under it while it is
 * tracked.
 *
 * For a polar orbiter this is the instrument's swath: a strip as wide as the
 * cross-track coverage, running back along the ground track for the last
 * few minutes, so the eye sees the picture being laid down rather than a
 * lone dot crossing an ocean. For a geostationary imager it is the disk it
 * stares at from its fixed longitude.
 *
 * The strip is rebuilt on the layer's one-second beat, never per frame: a
 * polygon hierarchy re-tessellates when it changes, and one rebuild a second
 * is invisible while sixty are not. It is a ground-classified polygon, so it
 * drapes onto the photoreal tiles as well as the globe.
 *
 * Nothing here is a camera view. The footprint says WHERE the sensor is
 * looking; the newest picture it took of that ground is whatever the imagery
 * slot is drawing, published on the instrument's own schedule.
 */
export function createFootprint({ state: layerState, parts }) {
  const EARTH_RADIUS_M = 6371008.8;

  /** Ground point `distanceM` from (lat, lon) along `bearingRad`, on a sphere. */
  function offset(latDeg, lonDeg, bearingRad, distanceM) {
    const lat1 = Cesium.Math.toRadians(latDeg);
    const lon1 = Cesium.Math.toRadians(lonDeg);
    const delta = distanceM / EARTH_RADIUS_M;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(delta) +
        Math.cos(lat1) * Math.sin(delta) * Math.cos(bearingRad),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearingRad) * Math.sin(delta) * Math.cos(lat1),
        Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
      );
    return [Cesium.Math.toDegrees(lon2), Cesium.Math.toDegrees(lat2)];
  }

  /** Initial bearing from one ground point to the next, radians. */
  function bearing(fromLat, fromLon, toLat, toLon) {
    const φ1 = Cesium.Math.toRadians(fromLat);
    const φ2 = Cesium.Math.toRadians(toLat);
    const Δλ = Cesium.Math.toRadians(toLon - fromLon);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
      Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return Math.atan2(y, x);
  }

  /**
   * The swath strip as a flat [lon, lat, …] ring: the left edge back along
   * the track, then the right edge forward again. Pure — exported on the part
   * for tests.
   * @param {object} satrec
   * @param {Date} now
   * @param {number} swathKm
   * @returns {number[]|null}
   */
  function swathRing(satrec, now, swathKm) {
    const halfM = (swathKm * 1000) / 2;
    const samples = [];
    for (let i = 0; i <= FOOTPRINT_TRAIL_STEPS; i++) {
      const t = new Date(
        now.getTime() -
          (FOOTPRINT_TRAIL_SECONDS * 1000 * i) / FOOTPRINT_TRAIL_STEPS,
      );
      const p = parts.orbits.propagatePosition(satrec, t);
      if (!p) return null;
      samples.push(p);
    }
    // samples[0] is now; the rest run back in time. Track bearing at each
    // sample is towards the NEXT-in-time sample (the previous array entry).
    const left = [];
    const right = [];
    for (let i = 0; i < samples.length; i++) {
      const here = samples[i];
      const ahead = samples[i - 1] || here;
      const behind = samples[i + 1] || here;
      const heading =
        ahead === here
          ? bearing(
              behind.latitude,
              behind.longitude,
              here.latitude,
              here.longitude,
            )
          : bearing(
              here.latitude,
              here.longitude,
              ahead.latitude,
              ahead.longitude,
            );
      left.push(
        offset(here.latitude, here.longitude, heading - Math.PI / 2, halfM),
      );
      right.push(
        offset(here.latitude, here.longitude, heading + Math.PI / 2, halfM),
      );
    }
    // A strip that crosses the antimeridian must not be drawn the long way
    // round; Cesium handles a ring under 180° wide, so unwrap longitudes to
    // stay continuous with the first sample.
    const ring = [...left, ...right.reverse()];
    const flat = [];
    const base = ring[0][0];
    for (const [lon, lat] of ring) {
      let l = lon;
      while (l - base > 180) l -= 360;
      while (l - base < -180) l += 360;
      flat.push(l, lat);
    }
    return flat;
  }

  function remove() {
    if (layerState._footprintEntity && layerState._viewer?.entities) {
      layerState._viewer.entities.remove(layerState._footprintEntity);
    }
    layerState._footprintEntity = null;
    layerState._footprintNorad = null;
    layerState._footprintUpdatedAt = 0;
    layerState._footprintRing = null;
  }

  /**
   * Show the footprint for the tracked satellite, or nothing when it is not
   * an imaging platform. Idempotent per satellite.
   */
  function follow(noradId) {
    if (layerState._footprintNorad === noradId) return;
    remove();
    const platform = imagingPlatformFor(noradId);
    const sat = layerState._catalog.get(noradId);
    if (!platform || !sat || !layerState._viewer?.entities) return;
    const swathKm = swathKmFor(platform);
    // No swath and not parked: a platform listed for what it carries rather
    // than what it images (the station's cameras) gets no footprint.
    if (swathKm === null && platform.orbit !== 'geostationary') return;
    layerState._footprintNorad = noradId;
    const color = Cesium.Color.fromCssColorString(FOOTPRINT_COLOR);
    if (swathKm === null) {
      // Geostationary: the disk it stares at, centred on the sub-satellite
      // point, which for a parked satellite barely moves.
      const pos = parts.orbits.propagatePosition(sat.satrec, new Date());
      if (!pos) return;
      layerState._footprintEntity = layerState._viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, 0),
        ellipse: {
          semiMajorAxis: FOOTPRINT_DISK_RADIUS_M,
          semiMinorAxis: FOOTPRINT_DISK_RADIUS_M,
          material: color.withAlpha(0.14),
          outline: true,
          outlineColor: color.withAlpha(0.8),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
      return;
    }
    layerState._footprintRing = swathRing(sat.satrec, new Date(), swathKm);
    layerState._footprintUpdatedAt = Date.now();
    layerState._footprintEntity = layerState._viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.CallbackProperty(
          () =>
            layerState._footprintRing
              ? new Cesium.PolygonHierarchy(
                  Cesium.Cartesian3.fromDegreesArray(layerState._footprintRing),
                )
              : undefined,
          false,
        ),
        material: color.withAlpha(0.24),
        outline: true,
        outlineColor: color.withAlpha(0.85),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
  }

  /** Called from the layer's pre-render tick; rebuilds the strip once a second. */
  function tick(nowMs) {
    if (layerState._footprintNorad === null || !layerState._footprintEntity)
      return;
    if (nowMs - layerState._footprintUpdatedAt < FOOTPRINT_REFRESH_MS) return;
    const sat = layerState._catalog.get(layerState._footprintNorad);
    const platform = imagingPlatformFor(layerState._footprintNorad);
    const swathKm = swathKmFor(platform);
    if (!sat || swathKm === null) return;
    const ring = swathRing(sat.satrec, new Date(nowMs), swathKm);
    if (ring) layerState._footprintRing = ring;
    layerState._footprintUpdatedAt = nowMs;
  }

  return { follow, remove, tick, swathRing };
}

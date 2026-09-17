import * as Cesium from 'cesium';
import { cameraPoseSignature, horizonOccluder } from './iconOrientation.js';

/**
 * Shared bookkeeping for a world-wide field of static point markers
 * (scanner systems, SDR receivers): ground-floored positions, horizon
 * culling, and a camera-proximity ranking for ambient labels.
 *
 * Why this exists: a point entity with `disableDepthTestDistance: Infinity`
 * is painted even when the Earth is between it and the camera, so a global
 * field of 1,800 dots projects hundreds of far-side markers onto whatever
 * city you are looking at — dots that slide against the terrain when the
 * camera moves and answer to no click. The radio layer solves this with the
 * shared horizon occluder; this module lifts that pattern out so the audio
 * layers share one implementation.
 *
 * @param {object} [options]
 * @param {{cachedGroundFloor?: Function, warmGroundFloor?: Function}|null} [options.ground]
 *   The surface ground-floor service; null renders at the ellipsoid.
 * @param {number} [options.liftM] Metres above the floor so a dot sits on it.
 */
export function createMarkerField({ ground = null, liftM = 2.5 } = {}) {
  /** @type {Map<string, {entity: any, lat: number, lon: number, position: Cesium.Cartesian3, floorM: number|null}>} */
  const _records = new Map();
  let _poseSignature = null;
  let _hiddenId = null;

  function floorAt(lat, lon) {
    const floor = ground?.cachedGroundFloor?.(lat, lon);
    return Number.isFinite(floor) ? floor : null;
  }

  function positionFor(lat, lon) {
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      (floorAt(lat, lon) ?? 0) + liftM,
    );
  }

  return {
    /** Ground-floored world position for a coordinate. */
    positionFor,
    /** Ask the terrain service to resolve floors for these points (fire-and-forget). */
    warm(points) {
      try {
        ground?.warmGroundFloor?.(points);
      } catch {
        /* floors are a visual nicety; never let them break a render */
      }
    },
    track(id, entity, lat, lon) {
      _records.set(String(id), {
        entity,
        lat,
        lon,
        position: entity.position.getValue(Cesium.JulianDate.now()),
        floorM: floorAt(lat, lon),
      });
    },
    untrack(id) {
      _records.delete(String(id));
    },
    clear() {
      _records.clear();
      _poseSignature = null;
      _hiddenId = null;
    },
    get size() {
      return _records.size;
    },
    /** The one marker kept hidden regardless of the horizon (the selected dot). */
    setHidden(id) {
      _hiddenId = id == null ? null : String(id);
      const record = _records.get(_hiddenId);
      if (record) record.entity.show = false;
    },
    /**
     * Re-read floors that have warmed since the marker was placed and move
     * those markers onto them. Cheap: a map lookup per marker, one entity
     * write per changed floor.
     * @returns {number} Markers moved.
     */
    reposition() {
      let moved = 0;
      for (const record of _records.values()) {
        const floor = floorAt(record.lat, record.lon);
        if (floor === null || floor === record.floorM) continue;
        record.floorM = floor;
        record.position = Cesium.Cartesian3.fromDegrees(
          record.lon,
          record.lat,
          floor + liftM,
        );
        record.entity.position = record.position;
        moved++;
      }
      return moved;
    },
    /**
     * Hide markers behind the horizon and rank the visible ones by distance
     * from the camera. Returns null when the camera has not moved since the
     * last call (unless forced), so callers can skip overlay rebuilds.
     * @param {any} camera Cesium camera.
     * @param {{force?: boolean}} [options]
     * @returns {string[]|null} Visible ids, nearest first.
     */
    cull(camera, { force = false } = {}) {
      if (!camera?.positionWC) return null;
      const signature = cameraPoseSignature(camera);
      if (!force && signature === _poseSignature) return null;
      _poseSignature = signature;
      const occluder = horizonOccluder(camera);
      const eye = camera.positionWC;
      const visible = [];
      for (const [id, record] of _records) {
        const inFront = occluder.isPointVisible(record.position);
        const show = inFront && id !== _hiddenId;
        if (record.entity.show !== show) record.entity.show = show;
        if (inFront)
          visible.push([Cesium.Cartesian3.distance(eye, record.position), id]);
      }
      visible.sort((a, b) => a[0] - b[0]);
      return visible.map(([, id]) => id);
    },
  };
}

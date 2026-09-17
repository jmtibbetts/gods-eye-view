/**
 * Region-monitor engine (pure): watch a circle on the globe and report what
 * enabled layers have inside it, flagging arrivals that are new since the last
 * scan. No Cesium, no DOM, no network — just the maths, so it is fully unit
 * tested and the panel stays a thin renderer over it.
 */

const EARTH_KM = 6371;
const TO_RAD = Math.PI / 180;

export function monitorDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * TO_RAD;
  const dLon = (lon2 - lon1) * TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * TO_RAD) * Math.cos(lat2 * TO_RAD) * Math.sin(dLon / 2) ** 2;
  return EARTH_KM * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Read a record's coordinate whichever way the layer spells it. */
export function recordLatLon(record) {
  const lat = Number(record?.lat ?? record?.latitude);
  const lon = Number(record?.lon ?? record?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Scan one watchbox against a set of layers.
 *
 * @param {{lat:number, lon:number, radiusKm:number}} box
 * @param {Array<{layerId:string, name:string, records:object[]}>} layers
 * @returns {{total:number, byLayer:Array<{layerId:string,name:string,count:number}>, ids:Set<string>}}
 */
export function scanWatchbox(box, layers) {
  const ids = new Set();
  const byLayer = [];
  let total = 0;
  for (const layer of layers) {
    let count = 0;
    for (const record of layer.records || []) {
      const point = recordLatLon(record);
      if (!point) continue;
      if (
        monitorDistanceKm(box.lat, box.lon, point.lat, point.lon) <=
        box.radiusKm
      ) {
        count++;
        ids.add(`${layer.layerId}:${record.id ?? `${point.lat},${point.lon}`}`);
      }
    }
    if (count)
      byLayer.push({ layerId: layer.layerId, name: layer.name, count });
    total += count;
  }
  byLayer.sort((a, b) => b.count - a.count);
  return { total, byLayer, ids };
}

/**
 * Diff a fresh scan against the previously-seen id set.
 * @param {Set<string>} previous
 * @param {Set<string>} current
 * @returns {{newIds: string[], goneIds: string[]}}
 */
export function diffScan(previous, current) {
  const newIds = [];
  const goneIds = [];
  for (const id of current) if (!previous.has(id)) newIds.push(id);
  for (const id of previous) if (!current.has(id)) goneIds.push(id);
  return { newIds, goneIds };
}

/** A short, human name for a new watchbox from a coordinate. */
export function defaultWatchboxName(lat, lon, index = 1) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `Watch ${index} · ${Math.abs(lat).toFixed(1)}${ns} ${Math.abs(lon).toFixed(1)}${ew}`;
}

/** Radius presets offered in the panel (km). */
export const MONITOR_RADII = Object.freeze([50, 150, 500, 1500]);

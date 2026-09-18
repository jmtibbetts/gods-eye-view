import {
  NHC_CURRENT_STORMS_URL,
  NHC_MAPSERVER,
  OUTLOOK_LAYERS,
  TROPICAL_FETCH_TIMEOUT_MS,
  geoJsonQueryUrl,
  layerIdsForBin,
} from './policy.js';
import {
  parseActiveStorms,
  parseDevelopmentRegions,
  parseDisturbances,
  parseTrackLines,
} from './records.js';

/**
 * NHC tropical source. Two upstreams, both keyless and both CORS-open:
 * the storm bulletin for what the storms ARE, and NOAA's tropical map service
 * for where their cones and tracks GO.
 *
 * Every fetch is individually fallible and individually optional. A missing
 * cone must not cost you the storm position, and a map service outage must not
 * empty a layer whose bulletin loaded fine — so failures degrade to null and
 * the caller draws what it has.
 */
export function createNhcTropicalSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = TROPICAL_FETCH_TIMEOUT_MS,
} = {}) {
  /** Cached map-service layer index; storm bins are renumbered as seasons run. */
  let layerIndex = null;
  let layerIndexAt = 0;

  async function getJson(url, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** Optional fetch: a failure is a missing piece, never a thrown error. */
  async function tryJson(url, signal) {
    try {
      return await getJson(url, signal);
    } catch {
      return null;
    }
  }

  /**
   * The map service's layer list. Refreshed hourly — the ids change only when
   * storms form or dissipate, and re-reading a 90 KB description per tick to
   * learn nothing would be wasteful.
   */
  async function getLayerIndex(signal) {
    const now = Date.now();
    if (layerIndex && now - layerIndexAt < 60 * 60_000) return layerIndex;
    const meta = await tryJson(`${NHC_MAPSERVER}?f=json`, signal);
    if (Array.isArray(meta?.layers)) {
      layerIndex = meta.layers;
      layerIndexAt = now;
    }
    return layerIndex || [];
  }

  return {
    /**
     * Fetch the whole tropical picture.
     *
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{storms:object[], disturbances:object[],
     *   regions:object[], geometry:Map<string,object>, bulletinOk:boolean,
     *   outlookOk:boolean}>}
     */
    async fetchTropical({ signal } = {}) {
      // The bulletin is the one required piece; outlook geometry is a bonus.
      let bulletin = null;
      let bulletinOk = true;
      try {
        bulletin = await getJson(NHC_CURRENT_STORMS_URL, signal);
      } catch {
        bulletinOk = false;
      }
      const storms = bulletinOk ? parseActiveStorms(bulletin) : [];

      const [disturbanceJson, regionJson] = await Promise.all([
        tryJson(geoJsonQueryUrl(OUTLOOK_LAYERS.disturbances), signal),
        tryJson(geoJsonQueryUrl(OUTLOOK_LAYERS.developmentRegions), signal),
      ]);
      const outlookOk = Boolean(disturbanceJson || regionJson);

      // Per-storm geometry, only for storms that actually exist right now.
      const geometry = new Map();
      if (storms.length) {
        const layers = await getLayerIndex(signal);
        await Promise.all(
          storms.map(async (storm) => {
            const ids = layerIdsForBin(layers, storm.bin);
            const [cone, forecast, past] = await Promise.all([
              ids.cone == null
                ? null
                : tryJson(geoJsonQueryUrl(ids.cone), signal),
              ids.forecastTrack == null
                ? null
                : tryJson(geoJsonQueryUrl(ids.forecastTrack), signal),
              ids.pastTrack == null
                ? null
                : tryJson(geoJsonQueryUrl(ids.pastTrack), signal),
            ]);
            geometry.set(storm.id, {
              cone: cone ? parseDevelopmentRegions(cone) : [],
              forecastTrack: forecast ? parseTrackLines(forecast) : [],
              pastTrack: past ? parseTrackLines(past) : [],
            });
          }),
        );
      }

      return {
        storms,
        disturbances: disturbanceJson ? parseDisturbances(disturbanceJson) : [],
        regions: regionJson ? parseDevelopmentRegions(regionJson) : [],
        geometry,
        bulletinOk,
        outlookOk,
      };
    },
  };
}

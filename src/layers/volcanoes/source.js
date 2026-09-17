import {
  USGS_ELEVATED_URL,
  VOLCANOES_FETCH_TIMEOUT_MS,
  VOLCANO_COORDINATES_URL,
} from './policy.js';
import {
  normalizeVolcanoAlerts,
  normalizeVolcanoCoordinates,
} from './records.js';

/**
 * Live USGS volcanic-alert source, joined to the bundled coordinate lookup.
 *
 * The lookup is fetched once and cached for the life of the source: it ships
 * with the build and cannot change under us, while the notices are re-read on
 * every tick.
 *
 * @param {{fetchImpl?: typeof fetch, url?: string, coordinatesUrl?: string}} [options]
 */
export function createUsgsVolcanoSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = USGS_ELEVATED_URL,
  coordinatesUrl = VOLCANO_COORDINATES_URL,
} = {}) {
  /** @type {Map<string, {lat:number, lon:number, elev:number|null}>|null} */
  let coordinates = null;

  async function loadCoordinates(signal) {
    if (coordinates) return coordinates;
    const response = await fetchImpl(coordinatesUrl, {
      signal,
      cache: 'force-cache',
    });
    if (!response.ok)
      throw new Error(`Volcano coordinates HTTP ${response.status}`);
    coordinates = normalizeVolcanoCoordinates(await response.json());
    if (!coordinates.size) throw new Error('Empty volcano coordinate table');
    return coordinates;
  }

  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        VOLCANOES_FETCH_TIMEOUT_MS,
      );
      const onAbort = () => timeout.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const table = await loadCoordinates(timeout.signal);
        const response = await fetchImpl(url, {
          signal: timeout.signal,
          cache: 'no-store',
        });
        if (!response.ok)
          throw new Error(`USGS volcanoes HTTP ${response.status}`);
        const payload = await response.json();
        signal?.throwIfAborted();
        const normalized = normalizeVolcanoAlerts(payload, table);
        if (!normalized) throw new Error('Malformed USGS volcano payload');
        return normalized;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

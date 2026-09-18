import { SATNOGS_FETCH_TIMEOUT_MS, SATNOGS_STATIONS_URL } from './policy.js';
import { parseStations } from './records.js';

/**
 * SatNOGS station source.
 *
 * Reads through this project's own proxy rather than network.satnogs.org
 * directly: the upstream sends no CORS headers on any method, so a browser
 * cannot read it at all. See server/providers/satnogs.js.
 */
export function createSatnogsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = SATNOGS_FETCH_TIMEOUT_MS,
  url = SATNOGS_STATIONS_URL,
} = {}) {
  return {
    async fetchStations(scope, { signal, now } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`SatNOGS HTTP ${response.status}`);
        const payload = await response.json();
        // The proxy answers 503 with an `error` body when it has nothing at
        // all to serve, which must not read as "no stations exist".
        if (payload && !Array.isArray(payload) && payload.error)
          throw new Error(`SatNOGS unavailable: ${payload.error}`);
        return parseStations(payload, scope, now);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

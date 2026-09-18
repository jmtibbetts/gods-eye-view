import { RIVER_FLOOD_FETCH_TIMEOUT_MS, floodQueryUrl } from './policy.js';
import { parseGauges } from './records.js';

/** NWPS gauge source. Keyless and CORS-open, like the other NOAA map services. */
export function createNwpsGaugeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = RIVER_FLOOD_FETCH_TIMEOUT_MS,
} = {}) {
  return {
    async fetchGauges(horizon, { signal } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(floodQueryUrl(horizon), {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`NWPS HTTP ${response.status}`);
        const payload = await response.json();
        // ArcGIS reports query errors inside a 200 response, so a body with an
        // `error` must not be read as "no gauges are flooding".
        if (payload?.error)
          throw new Error(
            `NWPS query error: ${payload.error.message || 'unknown'}`,
          );
        return parseGauges(payload, horizon);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

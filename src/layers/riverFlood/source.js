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
      // Abort WITH a reason. Without one the browser rejects with "signal is
      // aborted without reason", which reaches the layer panel verbatim and
      // tells the reader nothing about what went wrong.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new Error(
            `NWPS request timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
      }, timeoutMs);
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
      } catch (error) {
        if (timedOut)
          throw new Error(
            `NWPS request timed out after ${Math.round(timeoutMs / 1000)}s`,
          );
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

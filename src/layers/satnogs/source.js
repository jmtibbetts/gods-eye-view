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
      // Abort WITH a reason. Without one the browser rejects with "signal is
      // aborted without reason", which reaches the layer panel verbatim and
      // tells the reader nothing about what went wrong.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new Error(
            `SatNOGS request timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
      }, timeoutMs);
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
      } catch (error) {
        if (timedOut)
          throw new Error(
            `SatNOGS request timed out after ${Math.round(timeoutMs / 1000)}s`,
          );
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

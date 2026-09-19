import { AVIATION_FETCH_TIMEOUT_MS, AVIATION_SIGMETS_URL } from './policy.js';
import { parseSigmets } from './records.js';

/**
 * SIGMET source.
 *
 * Reads through this project's own proxy: aviationweather.gov sends no CORS
 * headers, and the proxy also merges the international and domestic feeds,
 * which publish different schemas for the same thing. See
 * server/providers/aviation.js.
 */
export function createAviationHazardSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = AVIATION_FETCH_TIMEOUT_MS,
  url = AVIATION_SIGMETS_URL,
} = {}) {
  return {
    async fetchSigmets(filter, { signal, now } = {}) {
      const controller = new AbortController();
      // Abort WITH a reason. Without one the browser rejects with "signal is
      // aborted without reason", which reaches the layer panel verbatim and
      // tells the reader nothing about what went wrong.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new Error(
            `SIGMET request timed out after ${Math.round(timeoutMs / 1000)}s`,
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
        if (!response.ok) throw new Error(`SIGMET HTTP ${response.status}`);
        const payload = await response.json();
        // The proxy answers 503 with an `error` body when both upstreams are
        // down, which must not read as "no hazards are in force".
        if (payload && !Array.isArray(payload) && payload.error)
          throw new Error(`SIGMETs unavailable: ${payload.error}`);
        return parseSigmets(payload, filter, now);
      } catch (error) {
        if (timedOut)
          throw new Error(
            `SIGMET request timed out after ${Math.round(timeoutMs / 1000)}s`,
          );
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

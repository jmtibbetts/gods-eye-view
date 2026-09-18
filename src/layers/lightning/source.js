import { LIGHTNING_FETCH_TIMEOUT_MS, LIGHTNING_FLASHES_URL } from './policy.js';
import { parseFlashes } from './records.js';

/**
 * Lightning source.
 *
 * Reads through this project's own proxy, which parses the netCDF-4 files
 * server side. See server/providers/lightning.js.
 */
export function createLightningSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = LIGHTNING_FETCH_TIMEOUT_MS,
  url = LIGHTNING_FLASHES_URL,
} = {}) {
  return {
    async fetchFlashes({ signal } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Lightning HTTP ${response.status}`);
        const payload = await response.json();
        // Both satellites failing answers 503 with an `error` body, which must
        // not read as "no lightning anywhere".
        if (payload?.error)
          throw new Error(`Lightning unavailable: ${payload.error}`);
        return parseFlashes(payload);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

import { DROUGHT_FETCH_TIMEOUT_MS, droughtQueryUrl } from './policy.js';
import { parseDrought } from './records.js';

/** Drought source. Both services are keyless and CORS-open. */
export function createDroughtSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = DROUGHT_FETCH_TIMEOUT_MS,
} = {}) {
  return {
    async fetchDrought(product, { signal } = {}) {
      const controller = new AbortController();
      // Abort WITH a reason. Without one the browser rejects with "signal is
      // aborted without reason", which reaches the layer panel verbatim and
      // tells the reader nothing about what went wrong.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new Error(
            `Drought request timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
      }, timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(droughtQueryUrl(product), {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Drought HTTP ${response.status}`);
        const payload = await response.json();
        // ArcGIS reports query errors inside a 200 response, so a body with an
        // `error` must not be read as "nowhere is in drought".
        if (payload?.error)
          throw new Error(
            `Drought query error: ${payload.error.message || 'unknown'}`,
          );
        return parseDrought(payload, product);
      } catch (error) {
        if (timedOut)
          throw new Error(
            `Drought request timed out after ${Math.round(timeoutMs / 1000)}s`,
          );
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

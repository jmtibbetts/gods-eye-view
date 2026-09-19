import { TFR_FETCH_TIMEOUT_MS, TFR_URL } from './policy.js';

/**
 * TFR source: the proxy's merged list-plus-shapes body, as it is. Parsing
 * into drawable areas happens in the layer, because the filter is the
 * layer's and the LAUNCH panel wants the same body unfiltered.
 */
export function createTfrSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = TFR_FETCH_TIMEOUT_MS,
  url = TFR_URL,
} = {}) {
  return {
    async fetchTfrs({ signal } = {}) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new Error(
            `TFR request timed out after ${Math.round(timeoutMs / 1000)}s`,
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
        if (!response.ok) throw new Error(`TFR HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.error)
          throw new Error(`TFRs unavailable: ${payload.error}`);
        if (!Array.isArray(payload?.tfrs))
          throw new Error('TFR body is not a list');
        return payload;
      } catch (error) {
        if (timedOut)
          throw new Error(
            `TFR request timed out after ${Math.round(timeoutMs / 1000)}s`,
          );
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

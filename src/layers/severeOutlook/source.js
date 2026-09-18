import { SEVERE_OUTLOOK_FETCH_TIMEOUT_MS, outlookUrl } from './policy.js';
import { outlookStatement, parseOutlook } from './records.js';

/**
 * SPC outlook source. The products are static GeoJSON files on spc.noaa.gov,
 * keyless and CORS-open, so no proxy is needed — unlike the NHC bulletin,
 * which is the same agency and is not.
 */
export function createSpcOutlookSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = SEVERE_OUTLOOK_FETCH_TIMEOUT_MS,
} = {}) {
  return {
    /**
     * @param {object} product A catalog entry.
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{areas: object[], statement: string|null}>}
     */
    async fetchOutlook(product, { signal } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(outlookUrl(product), {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`SPC HTTP ${response.status}`);
        const payload = await response.json();
        return {
          areas: parseOutlook(payload, product),
          statement: outlookStatement(payload),
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

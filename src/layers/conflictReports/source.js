import {
  CONFLICT_FETCH_TIMEOUT_MS,
  CONFLICT_REPORTS_URL,
  COUNTRIES_URL,
  indexCountries,
} from './policy.js';
import { parseReports } from './records.js';

/**
 * Conflict-reporting source.
 *
 * Two fetches with very different lifetimes: the country boundaries are a
 * bundled file that never changes within a session, so they are loaded once
 * and kept; the counts change every fifteen minutes.
 */
export function createConflictSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = CONFLICT_FETCH_TIMEOUT_MS,
  url = CONFLICT_REPORTS_URL,
  countriesUrl = COUNTRIES_URL,
} = {}) {
  /** @type {?Promise<Map<string, object[]>>} */
  let countries = null;

  function loadCountries() {
    if (!countries) {
      countries = (async () => {
        const response = await fetchImpl(countriesUrl);
        if (!response.ok)
          throw new Error(`country pack HTTP ${response.status}`);
        return indexCountries(await response.json());
      })().catch((error) => {
        // Do not cache the failure: without boundaries the layer can draw
        // nothing at all, so a later attempt must be allowed to succeed.
        countries = null;
        throw error;
      });
    }
    return countries;
  }

  return {
    async fetchReports({ signal } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const index = await loadCountries();
        // The country pack can take a moment on a cold start, and the caller
        // may have given up in the meantime. Real `fetch` rejects on an
        // already-aborted signal, but starting a request we know is cancelled
        // is work nobody is waiting for.
        if (controller.signal.aborted)
          throw new Error('Conflict fetch aborted');
        const response = await fetchImpl(url, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Conflict HTTP ${response.status}`);
        const payload = await response.json();
        // A failed upstream answers with an `error` body, which must not read
        // as "nowhere is reporting violence".
        if (payload?.error)
          throw new Error(`Conflict data unavailable: ${payload.error}`);
        const areas = parseReports(payload, index);
        Object.defineProperty(areas, 'payload', {
          value: payload,
          enumerable: false,
        });
        return areas;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

import { ATC_DIRECTORY_URL, ATC_FETCH_TIMEOUT_MS } from './policy.js';
import { normalizeAtcDirectory } from './records.js';

/**
 * Bundled ATC directory. Shaped like the other snapshot sources so a live
 * directory (a NASR refresh proxy) can replace it without touching the layer.
 * @param {{fetchImpl?: typeof fetch, directoryUrl?: string}} [options]
 */
export function createBundledAtcSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  directoryUrl = ATC_DIRECTORY_URL,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), ATC_FETCH_TIMEOUT_MS);
      const onAbort = () => timeout.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(directoryUrl, {
          signal: timeout.signal,
          cache: 'force-cache',
        });
        if (!response.ok)
          throw new Error(`ATC directory HTTP ${response.status}`);
        const payload = await response.json();
        signal?.throwIfAborted();
        const directory = normalizeAtcDirectory(payload);
        if (!directory) throw new Error('Malformed ATC directory');
        return {
          airports: directory.airports,
          centers: directory.centers,
          builtAt: payload?._meta?.built ?? null,
          cycle: payload?._meta?.sources?.US ?? null,
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

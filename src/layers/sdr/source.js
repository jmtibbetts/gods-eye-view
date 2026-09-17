import { SDR_DIRECTORY_URL, SDR_FETCH_TIMEOUT_MS } from './policy.js';
import { normalizeSdrDirectory } from './records.js';

/**
 * Bundled receiver directory. Shaped like the other snapshot sources so a
 * live directory (a refresh proxy) can replace it without touching the layer.
 * @param {{fetchImpl?: typeof fetch, directoryUrl?: string}} [options]
 */
export function createBundledSdrSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  directoryUrl = SDR_DIRECTORY_URL,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), SDR_FETCH_TIMEOUT_MS);
      const onAbort = () => timeout.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(directoryUrl, {
          signal: timeout.signal,
          cache: 'force-cache',
        });
        if (!response.ok)
          throw new Error(`SDR directory HTTP ${response.status}`);
        const payload = await response.json();
        signal?.throwIfAborted();
        const rows = normalizeSdrDirectory(payload);
        if (!rows) throw new Error('Malformed SDR directory');
        return { rows, builtAt: payload?._meta?.built ?? null };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

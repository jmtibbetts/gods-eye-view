import {
  OPENMHZ_API_ORIGIN,
  SCANNER_FETCH_TIMEOUT_MS,
  SCANNER_SEED_URL,
} from './policy.js';
import {
  normalizeScannerCalls,
  normalizeScannerGroups,
  normalizeScannerSeed,
  normalizeScannerSystems,
  normalizeScannerTalkgroups,
} from './records.js';

const SYSTEM_ID_RE = /^[a-z0-9_-]{1,40}$/i;

function assertSystemId(id) {
  if (!SYSTEM_ID_RE.test(String(id ?? '')))
    throw new Error('Invalid scanner system id');
  return String(id);
}

/**
 * OpenMHz read access: bundled seed + live catalog, talkgroup labels and
 * call lists. Every response is validated before it reaches the layer, and
 * every request honors the caller's AbortSignal plus a hard timeout.
 * @param {{fetchImpl?: typeof fetch, apiOrigin?: string, seedUrl?: string}} [options]
 */
export function createOpenMhzSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiOrigin = OPENMHZ_API_ORIGIN,
  seedUrl = SCANNER_SEED_URL,
} = {}) {
  async function readJson(url, { signal, cache } = {}) {
    signal?.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), SCANNER_FETCH_TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        signal: timeout.signal,
        ...(cache ? { cache } : {}),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* best effort */
        }
        throw new Error(`OpenMHz HTTP ${response.status}`);
      }
      const json = await response.json();
      signal?.throwIfAborted();
      return json;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    /** Bundled geocoded seed — the only place positions come from. */
    async getSeed({ signal } = {}) {
      const rows = normalizeScannerSeed(
        await readJson(seedUrl, { signal, cache: 'force-cache' }),
      );
      if (!rows) throw new Error('Malformed scanner seed');
      return rows;
    },
    /** Live activity for every system (no positions). */
    async getSystems({ signal } = {}) {
      const rows = normalizeScannerSystems(
        await readJson(`${apiOrigin}/systems`, { signal }),
      );
      if (!rows) throw new Error('Malformed OpenMHz systems response');
      return rows;
    },
    async getTalkgroups(systemId, { signal } = {}) {
      const id = assertSystemId(systemId);
      return normalizeScannerTalkgroups(
        await readJson(`${apiOrigin}/${id}/talkgroups`, { signal }),
      );
    },
    async getGroups(systemId, { signal } = {}) {
      const id = assertSystemId(systemId);
      return normalizeScannerGroups(
        await readJson(`${apiOrigin}/${id}/groups`, { signal }),
      );
    },
    /** Newest 50, descending. */
    async getRecentCalls(systemId, { signal } = {}) {
      const id = assertSystemId(systemId);
      const rows = normalizeScannerCalls(
        await readJson(`${apiOrigin}/${id}/calls`, { signal }),
      );
      if (!rows) throw new Error('Malformed OpenMHz calls response');
      return rows;
    },
    /** Calls strictly newer than `sinceMs`, ascending (epoch **milliseconds**). */
    async getNewerCalls(systemId, sinceMs, { signal } = {}) {
      const id = assertSystemId(systemId);
      const since = Math.max(0, Math.floor(Number(sinceMs) || 0));
      const rows = normalizeScannerCalls(
        await readJson(`${apiOrigin}/${id}/calls/newer?time=${since}`, {
          signal,
        }),
      );
      if (!rows) throw new Error('Malformed OpenMHz calls response');
      return rows;
    },
  };
}

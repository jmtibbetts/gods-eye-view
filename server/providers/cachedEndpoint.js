/**
 * A cached, coalesced, serve-stale JSON endpoint for the upstream proxies.
 *
 * Three proxies now need the same five behaviours, and the third copy is where
 * a shared helper stops being premature:
 *
 *   - cache with a TTL, so a public service is not hammered per page load;
 *   - coalesce concurrent misses, so ten layers enabling at once make one call;
 *   - validate the SHAPE before caching, because an upstream error page parses
 *     as JSON perfectly well and would then be served confidently for the whole
 *     TTL as if it were the data;
 *   - serve stale on failure, because slightly old data beats an empty globe
 *     and every layer reports its own last-update time;
 *   - answer 503 with an `error` body only when there is nothing at all to
 *     serve, so a client can tell "upstream down" from "nothing to report".
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {object} options
 * @param {number} options.ttlMs How long a successful body stays fresh.
 * @param {string} options.label Used in warnings.
 * @param {string} [options.url] Upstream URL, for the single-upstream case.
 * @param {() => Promise<any>} [options.load] Supply the payload yourself,
 *   instead of `url`. This is how an endpoint that merges SEVERAL upstreams
 *   gets the caching, coalescing and serve-stale behaviour without
 *   reimplementing it. Throw to report failure.
 * @param {string} [options.agent] User-agent to send.
 * @param {number} [options.timeoutMs]
 * @param {(payload: any) => any} [options.shape] Validate and transform the
 *   parsed payload. Throw to reject it. Defaults to identity.
 * @param {string} [options.diskCache] Absolute path to persist the last good
 *   body to. Serve-stale only helps a process that already succeeded once;
 *   an upstream that is down when the server STARTS leaves the layer empty
 *   with nothing to fall back on. With this set, the last good body survives a
 *   restart and is served (marked stale) while a refresh is attempted. Use it
 *   for upstreams that are known to be intermittent.
 * @returns {(req: any, res: any) => Promise<void>} A connect-style handler.
 */
export function cachedJsonEndpoint({
  url,
  load: loadPayload,
  ttlMs,
  label,
  agent = 'gods-eye-view',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  shape = (payload) => payload,
  diskCache = null,
}) {
  if (!url && typeof loadPayload !== 'function')
    throw new TypeError(`${label}: needs a url or a load function`);
  /** @type {?{at:number, body:string}} */
  let cache = null;
  /** @type {?Promise<?string>} */
  let inflight = null;
  /** Read the on-disk fallback once, lazily, and only if nothing is in memory. */
  let diskRead = null;

  async function fromDisk() {
    if (!diskCache) return null;
    if (!diskRead) {
      diskRead = readFile(diskCache, 'utf8').catch(() => null);
    }
    const body = await diskRead;
    if (!body) return null;
    try {
      JSON.parse(body);
    } catch {
      // A truncated or corrupt cache file is worse than none.
      return null;
    }
    return body;
  }

  async function toDisk(body) {
    if (!diskCache) return;
    try {
      await mkdir(dirname(diskCache), { recursive: true });
      await writeFile(diskCache, body, 'utf8');
    } catch (error) {
      console.warn(`[${label}] could not persist cache: ${error?.message}`);
    }
  }

  async function fetchJson() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': agent },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function load() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const payload = loadPayload ? await loadPayload() : await fetchJson();
        const body = JSON.stringify(shape(payload));
        cache = { at: Date.now(), body };
        await toDisk(body);
        return body;
      } catch (error) {
        console.warn(`[${label}] fetch failed: ${error?.message}`);
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return async function handle(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const fresh = cache && Date.now() - cache.at < ttlMs;
    const body = fresh ? cache.body : await load();
    if (body) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.end(body);
      return;
    }
    if (cache) {
      res.setHeader('X-Gev-Stale', '1');
      res.end(cache.body);
      return;
    }
    // Nothing in memory: fall back to the last good body from a previous run,
    // still marked stale so the client knows it is not current.
    const persisted = await fromDisk();
    if (persisted) {
      res.setHeader('X-Gev-Stale', '1');
      res.end(persisted);
      return;
    }
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'upstream_failed' }));
  };
}

/** Assert an upstream returned a list, then map it. Throws if it did not. */
export function listOf(trim) {
  return (payload) => {
    if (!Array.isArray(payload))
      throw new Error('upstream did not return a list');
    return payload.map(trim);
  };
}

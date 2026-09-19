import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  readResponseTextCapped,
  coalesceProxyRequest,
} from '../common/http.js';
import {
  launchLibraryRecentUrl,
  launchLibraryUpcomingUrl,
} from '../../../src/data/spaceProviderRequests.js';

export const LL2_CACHE_TTL_MS = 15 * 60_000;
/**
 * The upcoming feed turns over faster — a scrub, a hold, a webcast going
 * live — so it is held for a third as long. Both feeds together stay under
 * LL2's keyless allowance of 15 requests an hour: 4 + 10, and only while a
 * client is actually asking.
 */
export const LL2_UPCOMING_CACHE_TTL_MS = 6 * 60_000;
export const LL2_UPCOMING_LIMIT = 12;

/** Build LL2 request headers without exposing its optional token client-side. */
export function launchLibraryRequestHeaders(token = process.env.LL2_API_TOKEN) {
  const normalized = String(token || '').trim();
  return {
    Accept: 'application/json',
    ...(normalized ? { Authorization: `Token ${normalized}` } : {}),
  };
}

function send(res, status, body, cacheState, maxAgeSeconds = 900) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control':
      status === 200 ? `public, max-age=${maxAgeSeconds}` : 'no-store',
    'X-GEV-Cache': cacheState,
  });
  res.end(body);
}

/**
 * One cached LL2 feed: memory, then disk, then upstream; stale served on a
 * failed refresh. The recent and upcoming feeds are two of these.
 */
function createLaunchFeed({ key, cacheFile, ttlMs, buildUrl }) {
  const maxResponseBytes = 12 * 1024 * 1024;
  const maxDiskCacheBytes = 24 * 1024 * 1024;
  const cachePath = path.join(process.cwd(), '.gev-cache', cacheFile);
  let cache = null;
  let diskLoaded = false;
  const inFlight = new Map();

  async function loadDiskCache() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const stat = await fsp.stat(cachePath);
      if (stat.size > maxDiskCacheBytes)
        throw new Error('cache file too large');
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (Number.isFinite(parsed?.at) && typeof parsed?.body === 'string') {
        const body = JSON.parse(parsed.body);
        if (Array.isArray(body?.results)) cache = parsed;
      }
    } catch {
      /* first run or invalid cache */
    }
  }

  async function saveDiskCache(entry) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch (error) {
      console.warn('[launch-library-proxy] cache write failed');
    }
  }

  async function refreshUpstream() {
    const url = buildUrl(new Date());
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: launchLibraryRequestHeaders(),
    });
    const body = await readResponseTextCapped(upstream, maxResponseBytes);
    if (!upstream.ok) {
      const error = new Error(`upstream HTTP ${upstream.status}`);
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.results))
      throw new Error('malformed upstream response');
    const fresh = { at: Date.now(), body };
    cache = fresh;
    void saveDiskCache(fresh);
    return fresh;
  }

  async function serve(res) {
    await loadDiskCache();
    const now = Date.now();
    const maxAge = Math.round(ttlMs / 1000);
    if (cache && now - cache.at < ttlMs) {
      send(res, 200, cache.body, 'HIT', maxAge);
      return;
    }
    const stale = cache;
    const request = coalesceProxyRequest(inFlight, key, refreshUpstream);
    try {
      const fresh = await request.promise;
      send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS', maxAge);
    } catch (error) {
      // Log only a bounded status, never upstream bodies, URLs, or credentials.
      const status = Number.isInteger(error?.upstreamStatus)
        ? error.upstreamStatus
        : 502;
      if (!request.shared)
        console.warn(
          `[launch-library-proxy] ${key} refresh failed (HTTP ${status})${stale ? ' — serving stale cache' : ''}`,
        );
      if (stale) {
        send(res, 200, stale.body, 'STALE-ERROR', maxAge);
        return;
      }
      send(
        res,
        status,
        JSON.stringify({ error: 'Launch Library 2 unavailable' }),
        'NONE',
      );
    }
  }

  return { serve };
}

/**
 * Proxy the public Launch Library 2 feeds server-side: `/api/launches` is
 * the last 30 days (Space Missions), `/api/launches/upcoming` the next
 * dozen in net order (the LAUNCH panel's countdowns and webcasts).
 */
export function rocketLaunchesProxy() {
  const recent = createLaunchFeed({
    key: 'recent-launches',
    cacheFile: 'launch-library-2-v2.3.json',
    ttlMs: LL2_CACHE_TTL_MS,
    buildUrl: (now) => launchLibraryRecentUrl(now),
  });
  const upcoming = createLaunchFeed({
    key: 'upcoming-launches',
    cacheFile: 'launch-library-2-upcoming-v2.3.json',
    ttlMs: LL2_UPCOMING_CACHE_TTL_MS,
    buildUrl: () => launchLibraryUpcomingUrl(LL2_UPCOMING_LIMIT),
  });

  function install(middlewares) {
    middlewares.use('/api/launches', async (req, res) => {
      if (req.method !== 'GET') {
        send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
        return;
      }
      const route = String(req.url || '/').split('?')[0];
      if (route === '/upcoming' || route === '/upcoming/') {
        await upcoming.serve(res);
        return;
      }
      await recent.serve(res);
    });
  }

  return {
    name: 'rocket-launches-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

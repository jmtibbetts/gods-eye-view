/**
 * NHC active-storm bulletin proxy.
 *
 * CurrentStorms.json is keyless and public, but nhc.noaa.gov does not send
 * `access-control-allow-origin`, so a browser cannot read it: the fetch fails
 * with an opaque TypeError and the storm half of the tropical layer would be
 * permanently empty while looking merely quiet. NOAA's tropical MAP service
 * does send CORS headers, which is why the outlook worked and the bulletin did
 * not — an asymmetry that is invisible until you try it in a browser.
 *
 * So this reads it server side. It is a pass-through, not an integration:
 * no key, no transformation, a short cache so advisory time is respected
 * without hammering NOAA.
 *
 * Route:
 *   GET /api/nhc/storms → the upstream JSON, or {activeStorms:[]} on failure
 */

const UPSTREAM = 'https://www.nhc.noaa.gov/CurrentStorms.json';
/** Advisories issue every 6 h; 5 minutes is far fresher than the data. */
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

export function tropicalProxy() {
  /** @type {?{at:number, body:string}} */
  let cache = null;
  /** @type {?Promise<?string>} */
  let inflight = null;

  async function fetchUpstream() {
    if (inflight) return inflight;
    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(UPSTREAM, {
          signal: controller.signal,
          headers: { 'user-agent': 'gods-eye-view/tropical' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        // Parse to validate before caching — caching a 502 HTML page as if it
        // were the bulletin would then be served confidently for 5 minutes.
        JSON.parse(body);
        cache = { at: Date.now(), body };
        return body;
      } catch (error) {
        console.warn(`[NHC] bulletin fetch failed: ${error?.message}`);
        return null;
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/nhc/storms', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const fresh = cache && Date.now() - cache.at < TTL_MS;
      const body = fresh ? cache.body : await fetchUpstream();
      if (body) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.end(body);
        return;
      }
      // Serve stale rather than nothing: a slightly old storm position beats
      // an empty ocean, and the layer reports its own last-update time.
      if (cache) {
        res.setHeader('X-Gev-Stale', '1');
        res.end(cache.body);
        return;
      }
      res.statusCode = 503;
      res.end(JSON.stringify({ activeStorms: [], error: 'upstream_failed' }));
    });
  }

  return {
    name: 'gev-tropical-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

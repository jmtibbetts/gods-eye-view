/**
 * SatNOGS ground-station proxy.
 *
 * network.satnogs.org is keyless and public but sends no
 * `access-control-allow-origin` on any method — GET or OPTIONS — so a browser
 * cannot read it at all. Same shape as the NHC bulletin: the fetch fails with
 * an opaque TypeError and the layer would sit permanently empty while looking
 * merely quiet.
 *
 * It also TRIMS, which the NHC proxy does not need to. The stations endpoint is
 * 3.75 MB of JSON, most of it fields this layer never reads — descriptions,
 * images, owner records, per-antenna detail. Keeping the dozen fields the globe
 * actually uses takes it to about 1.2 MB, roughly a third, and the saving is on
 * the user's connection rather than ours.
 *
 * It trims fields and nothing else: which stations are worth DRAWING is the
 * layer's decision, not the proxy's, so nothing is filtered out here.
 *
 * Routes:
 *   GET /api/satnogs/stations     → trimmed station list
 *   GET /api/satnogs/observations → trimmed recent observations
 */

const STATIONS_URL = 'https://network.satnogs.org/api/stations/?format=json';
const OBSERVATIONS_URL =
  'https://network.satnogs.org/api/observations/?format=json';

/**
 * Stations heartbeat on the order of minutes and the upstream sets a one-hour
 * cache header of its own; ten minutes is fresher than the data changes and
 * well short of what would count as hammering a volunteer-run network.
 */
const STATIONS_TTL_MS = 10 * 60_000;
/** Observations land continuously; a shorter window is worth it here. */
const OBSERVATIONS_TTL_MS = 2 * 60_000;
const TIMEOUT_MS = 30_000;

/** The only station fields the globe reads. */
function trimStation(s) {
  return {
    id: s.id,
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    altitude: s.altitude,
    status: s.status,
    connected: s.is_connected,
    available: s.is_available,
    testing: s.testing,
    observations: s.observations,
    future: s.future_observations,
    successRate: s.success_rate,
    lastSeen: s.last_seen,
    // Bands rather than whole antenna records: "VHF, UHF" is what a reader
    // wants, and the full per-antenna detail is most of the payload.
    //
    // Some records already carry a comma-joined list in a single `band`
    // ("HF, VHF, UHF"), so splitting before the de-duplication is what keeps
    // one station's "VHF" and another's "HF, VHF, UHF" from being counted as
    // two unrelated bands.
    bands: Array.isArray(s.antenna)
      ? [
          ...new Set(
            s.antenna
              .flatMap((a) => String(a?.band ?? '').split(','))
              .map((b) => b.trim())
              .filter(Boolean),
          ),
        ]
      : [],
  };
}

/** The only observation fields the globe reads. */
function trimObservation(o) {
  return {
    id: o.id,
    start: o.start,
    end: o.end,
    station: o.ground_station,
    stationName: o.station_name,
    lat: o.station_lat,
    lng: o.station_lng,
    norad: o.norad_cat_id,
    satId: o.sat_id,
    status: o.status,
    mode: o.transmitter_mode,
    downlink: o.transmitter_downlink_low,
    waterfall: Boolean(o.waterfall),
    demod: Array.isArray(o.demoddata) ? o.demoddata.length : 0,
  };
}

/**
 * One cached upstream endpoint.
 * @param {string} url
 * @param {number} ttlMs
 * @param {(row: any) => any} trim
 * @param {string} label
 */
function endpoint(url, ttlMs, trim, label) {
  /** @type {?{at:number, body:string}} */
  let cache = null;
  /** @type {?Promise<?string>} */
  let inflight = null;

  async function load() {
    if (inflight) return inflight;
    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'user-agent': 'gods-eye-view/satnogs' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        // Validate the SHAPE before caching. A proxy error page parses as JSON
        // perfectly well and would then be served confidently as an empty
        // network for the whole TTL.
        if (!Array.isArray(payload))
          throw new Error('upstream did not return a list');
        const body = JSON.stringify(payload.map(trim));
        cache = { at: Date.now(), body };
        return body;
      } catch (error) {
        console.warn(`[SatNOGS] ${label} fetch failed: ${error?.message}`);
        return null;
      } finally {
        clearTimeout(timer);
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
    // Serve stale rather than nothing: a station list a few minutes old beats
    // an empty globe, and the layer reports its own last-update time.
    if (cache) {
      res.setHeader('X-Gev-Stale', '1');
      res.end(cache.body);
      return;
    }
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'upstream_failed' }));
  };
}

export function satnogsProxy() {
  const stations = endpoint(
    STATIONS_URL,
    STATIONS_TTL_MS,
    trimStation,
    'stations',
  );
  const observations = endpoint(
    OBSERVATIONS_URL,
    OBSERVATIONS_TTL_MS,
    trimObservation,
    'observations',
  );

  function installMiddleware(server) {
    server.middlewares.use('/api/satnogs/stations', stations);
    server.middlewares.use('/api/satnogs/observations', observations);
  }

  return {
    name: 'gev-satnogs-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

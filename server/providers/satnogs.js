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
 * Route:
 *   GET /api/satnogs/stations → trimmed station list
 */

import { join } from 'node:path';
import { cachedJsonEndpoint, listOf } from './cachedEndpoint.js';

const STATIONS_URL = 'https://network.satnogs.org/api/stations/?format=json';

/**
 * Stations heartbeat on the order of minutes and the upstream sets a one-hour
 * cache header of its own; ten minutes is fresher than the data changes and
 * well short of what would count as hammering a volunteer-run network.
 */
const STATIONS_TTL_MS = 10 * 60_000;

/**
 * Generous, because the upstream is a volunteer network serving an unpaginated
 * 3.75 MB response and it is genuinely slow — measured at 16 s for the small
 * observations endpoint and, on a bad day, a 504 after five minutes on the
 * station list. Thirty seconds was cutting off requests that would have
 * succeeded.
 */
const TIMEOUT_MS = 90_000;

/**
 * Where the last good station list is kept between runs.
 *
 * Serve-stale only rescues a process that already succeeded once. SatNOGS is
 * intermittent enough that a server started while it is down would otherwise
 * show an empty network — and an empty SatNOGS layer looks exactly like "no
 * stations are online", which is the one thing it must never imply.
 */
const CACHE_DIR = join(process.cwd(), 'node_modules', '.cache', 'gev');

/** The only station fields the globe reads. */
export function trimStation(s) {
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

export function satnogsProxy() {
  const stations = cachedJsonEndpoint({
    url: STATIONS_URL,
    ttlMs: STATIONS_TTL_MS,
    label: 'SatNOGS stations',
    agent: 'gods-eye-view/satnogs',
    timeoutMs: TIMEOUT_MS,
    shape: listOf(trimStation),
    diskCache: join(CACHE_DIR, 'satnogs-stations.json'),
  });

  function installMiddleware(server) {
    server.middlewares.use('/api/satnogs/stations', stations);
  }

  return {
    name: 'gev-satnogs-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

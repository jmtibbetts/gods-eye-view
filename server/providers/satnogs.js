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

import { cachedJsonEndpoint, listOf } from './cachedEndpoint.js';

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

export function satnogsProxy() {
  const stations = cachedJsonEndpoint({
    url: STATIONS_URL,
    ttlMs: STATIONS_TTL_MS,
    label: 'SatNOGS stations',
    agent: 'gods-eye-view/satnogs',
    timeoutMs: TIMEOUT_MS,
    shape: listOf(trimStation),
  });
  const observations = cachedJsonEndpoint({
    url: OBSERVATIONS_URL,
    ttlMs: OBSERVATIONS_TTL_MS,
    label: 'SatNOGS observations',
    agent: 'gods-eye-view/satnogs',
    timeoutMs: TIMEOUT_MS,
    shape: listOf(trimObservation),
  });

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

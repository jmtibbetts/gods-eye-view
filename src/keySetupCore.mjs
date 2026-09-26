/**
 * Key setup ("POWER UP") — the pure core.
 *
 * One registry, three pure functions, zero dependencies. The dev server's
 * /api/setup endpoints (vite.config.js) and the in-app panel (keySetup.js)
 * are both thin shells over this module, so what a key is called, what it
 * unlocks, and how a .env line is written each live in exactly one place.
 *
 * Nothing here touches the filesystem, the network, or process.env — callers
 * pass environments in and write text out, which is also what makes every
 * behavior below unit-testable.
 */

/** Longest accepted key/token value. Real provider keys are all far shorter. */
export const KEY_SETUP_VALUE_LIMIT = 512;

/** Most env vars accepted in one save. The registry defines ten. */
export const KEY_SETUP_UPDATE_LIMIT = 16;

/** Header line written above keys the panel appends to a .env file. */
export const KEY_SETUP_APPEND_HEADER =
  '# Keys added by the in-app POWER UP panel';

/**
 * Provider credentials, in display order — most magic per
 * minute first. `tier` mirrors the README's color legend: 'metered' (🔴) is a
 * billing-enabled account, 'free' (🟡) is a register-and-paste key.
 * `clientExposed` marks the two keys that are injected into the browser
 * bundle by design (restrict them at the provider, per SECURITY.md).
 * `hidden` keeps advanced configuration out of the panel and missing-key count.
 * `layers` names the data layers a key switches on or upgrades, so a test
 * can prove every layer in the registry is accounted for by some row.
 */
export const KEY_SETUP_KEYS = Object.freeze([
  Object.freeze({
    id: 'google-maps',
    layers: Object.freeze([]),
    title: 'GOOGLE MAPS',
    unlocks: 'The photorealistic 3D planet + place search',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_API_KEY']),
    tier: 'metered',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'google-maps-server',
    layers: Object.freeze([]),
    title: 'GOOGLE MAPS — SERVER',
    unlocks: 'Places context + Street View fallback; optional separate key',
    getUrl:
      'https://developers.google.com/maps/documentation/places/web-service/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_SERVER_API_KEY']),
    tier: 'metered',
    hidden: true,
  }),
  Object.freeze({
    id: 'openai',
    layers: Object.freeze([]),
    title: 'OPENAI',
    unlocks: 'Voice control — talk to the planet',
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: Object.freeze(['OPENAI_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'aisstream',
    layers: Object.freeze(['ais-live-vessels']),
    title: 'AISSTREAM',
    unlocks: 'Live ships, worldwide',
    getUrl: 'https://aisstream.io',
    envVars: Object.freeze(['AISSTREAM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'firms',
    layers: Object.freeze(['local-firms']),
    title: 'NASA FIRMS',
    unlocks: 'Live active-fire detections',
    getUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/',
    envVars: Object.freeze(['FIRMS_MAP_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'tomtom',
    layers: Object.freeze(['traffic']),
    title: 'TOMTOM',
    unlocks: 'Real live traffic (keyless runs a simulation)',
    getUrl: 'https://developer.tomtom.com',
    envVars: Object.freeze(['TOMTOM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'cesium-ion',
    layers: Object.freeze([]),
    title: 'CESIUM ION',
    unlocks: 'Bing imagery map stacks + world terrain',
    getUrl: 'https://ion.cesium.com/tokens',
    envVars: Object.freeze(['CESIUM_ION_TOKEN']),
    tier: 'free',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'opensky',
    layers: Object.freeze(['flights']),
    title: 'OPENSKY',
    unlocks: 'More flight-polling credits (anonymous works without)',
    getUrl: 'https://opensky-network.org',
    envVars: Object.freeze(['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'copernicus',
    layers: Object.freeze(['imagery-viirs']),
    title: 'COPERNICUS',
    unlocks: 'Sentinel-2 imagery at 10 m (all other imagery is keyless)',
    getUrl: 'https://dataspace.copernicus.eu',
    // Three values, not two: OGC services are addressed per configuration
    // instance, and the instance id forms the endpoint path — credentials
    // alone have nothing to point at. The id comes from the dashboard's
    // Configuration Utility; accounts ship with a usable "Simple WMS Instance".
    envVars: Object.freeze([
      'COPERNICUS_CLIENT_ID',
      'COPERNICUS_CLIENT_SECRET',
      'COPERNICUS_INSTANCE_ID',
    ]),
    tier: 'free',
  }),
  Object.freeze({
    id: 'launch-library',
    layers: Object.freeze(['rocket-launches']),
    title: 'LAUNCH LIBRARY',
    unlocks: 'Higher request allowance for Space Missions and the LAUNCH panel',
    getUrl: 'https://thespacedevs.com',
    envVars: Object.freeze(['LL2_API_TOKEN']),
    tier: 'free',
  }),
]);

/**
 * Everything else the globe talks to — no key, nothing to paste.
 *
 * The panel exists so nobody has to wonder what the globe is connected to.
 * Listing only the keyed providers answered half of that: the other thirty-
 * odd services run keyless by design, and a panel that did not name them
 * read as though the keyed handful were the whole picture. These rows carry
 * no fields, never count toward "keys waiting", and are the receipt for what
 * is already on. `feeds` names the layers and tools a service powers; `url`
 * is the service's own page or terms; `note` is the one caveat worth knowing
 * at a glance (a share-alike licence, a bundled snapshot, a regional feed).
 *
 * DATA_SOURCES.md is the full attribution and licence record; this is the
 * in-app summary of it, in the same order as the panel shows things.
 * `layers` names the data layers each service feeds; between these rows and
 * the keyed ones, every id in LAYER_STATE_REGISTRY must appear, so a layer
 * added without naming its source in the panel fails a test.
 */
export const KEY_SETUP_KEYLESS_SOURCES = Object.freeze([
  Object.freeze({
    id: 'esri-osm-basemap',
    layers: Object.freeze([]),
    title: 'ESRI WORLD IMAGERY · OPENSTREETMAP',
    feeds: 'The keyless satellite basemap, with OSM as the fallback',
    url: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
  }),
  Object.freeze({
    id: 'reearth-terrain',
    layers: Object.freeze([]),
    title: 'RE:EARTH TERRAIN',
    feeds: 'Keyless world terrain under every globe stack (Mapterhorn mesh)',
    url: 'https://reearth.io',
    note: 'CC BY 4.0',
  }),
  Object.freeze({
    id: 'adsb-lol',
    layers: Object.freeze(['military', 'military-awareness', 'flights']),
    title: 'ADSB.LOL',
    feeds:
      'Military flights and aircraft traces; the flight fallback when OpenSky has no snapshot',
    url: 'https://adsb.lol',
  }),
  Object.freeze({
    id: 'celestrak',
    layers: Object.freeze(['satellites']),
    title: 'CELESTRAK',
    feeds:
      'Satellite orbits (TLEs) for the whole catalog, Starlink shell included',
    url: 'https://celestrak.org',
  }),
  Object.freeze({
    id: 'usgs-earthquakes',
    layers: Object.freeze(['earthquakes']),
    title: 'USGS EARTHQUAKES',
    feeds: 'Global seismic activity, last 24 hours',
    url: 'https://earthquake.usgs.gov',
  }),
  Object.freeze({
    id: 'usgs-volcanoes',
    layers: Object.freeze(['volcanoes']),
    title: 'USGS VOLCANO HAZARDS',
    feeds: 'Volcano Alerts — every US-monitored volcano above background',
    url: 'https://volcanoes.usgs.gov',
    note: 'Positions from a bundled Smithsonian GVP lookup (Wikidata, CC0)',
  }),
  Object.freeze({
    id: 'nws-alerts',
    layers: Object.freeze(['weather-alerts']),
    title: 'US NATIONAL WEATHER SERVICE',
    feeds: 'Weather Alerts — active watches and warnings (api.weather.gov)',
    url: 'https://www.weather.gov/documentation/services-web-api',
  }),
  Object.freeze({
    id: 'noaa-spc',
    layers: Object.freeze(['storm-reports', 'severe-outlook']),
    title: 'NOAA STORM PREDICTION CENTER',
    feeds: 'Storm Reports and the Severe Outlook',
    url: 'https://www.spc.noaa.gov',
  }),
  Object.freeze({
    id: 'noaa-nhc',
    layers: Object.freeze(['tropical-cyclones', 'weather-cyclones']),
    title: 'NOAA NATIONAL HURRICANE CENTER',
    feeds:
      'Tropical Cyclones — active storms, cones, and the disturbances being watched',
    url: 'https://www.nhc.noaa.gov',
  }),
  Object.freeze({
    id: 'noaa-nwps',
    layers: Object.freeze(['river-flood']),
    title: 'NOAA NATIONAL WATER PREDICTION SERVICE',
    feeds:
      'River Flood — gauges at or above action stage, with forecast horizons',
    url: 'https://water.noaa.gov',
  }),
  Object.freeze({
    id: 'noaa-swpc',
    layers: Object.freeze(['space-weather']),
    title: 'NOAA SPACE WEATHER PREDICTION CENTER',
    feeds:
      'Space Weather — the OVATION aurora oval, Kp, the R/S/G scales and alerts',
    url: 'https://www.swpc.noaa.gov',
  }),
  Object.freeze({
    id: 'drought',
    layers: Object.freeze(['drought']),
    title: 'US DROUGHT MONITOR · NOAA CPC',
    feeds:
      'Drought — current conditions D0–D4 and the monthly and seasonal outlooks',
    url: 'https://droughtmonitor.unl.edu',
  }),
  Object.freeze({
    id: 'noaa-awc',
    layers: Object.freeze(['aviation-hazards']),
    title: 'NOAA AVIATION WEATHER CENTER',
    feeds:
      'Aviation Hazards — every SIGMET in force, international and US domestic',
    url: 'https://aviationweather.gov',
  }),
  Object.freeze({
    id: 'celestrak-socrates',
    layers: Object.freeze(['conjunctions']),
    title: 'CELESTRAK SOCRATES',
    feeds:
      'Conjunctions — the week’s closest approaches and highest probabilities, placed at closest approach',
    url: 'https://celestrak.org/SOCRATES/',
  }),
  Object.freeze({
    id: 'faa-tfr',
    layers: Object.freeze(['tfr']),
    title: 'FAA TEMPORARY FLIGHT RESTRICTIONS',
    feeds:
      'Flight Restrictions — every TFR in force with its shape; launch closures to the minute',
    url: 'https://tfr.faa.gov',
  }),
  Object.freeze({
    id: 'noaa-glm',
    layers: Object.freeze(['lightning']),
    title: 'NOAA GOES LIGHTNING MAPPER',
    feeds:
      'Lightning — individual flashes from GOES-East and GOES-West, via NOAA Open Data on AWS',
    url: 'https://www.noaa.gov/nodd',
    note: 'Western Hemisphere only',
  }),
  Object.freeze({
    id: 'epa-airnow',
    layers: Object.freeze(['air-quality']),
    title: 'EPA AIRNOW',
    feeds: "Air Quality — AQI contours in AirNow's own category colours",
    url: 'https://www.airnow.gov',
    note: 'US coverage',
  }),
  Object.freeze({
    id: 'rainviewer',
    layers: Object.freeze(['imagery-radar']),
    title: 'RAINVIEWER',
    feeds: 'Weather Radar — NEXRAD and global precipitation mosaics',
    url: 'https://www.rainviewer.com/api.html',
  }),
  Object.freeze({
    id: 'nasa-gibs',
    layers: Object.freeze([
      'imagery-viirs',
      'imagery-science',
      'recent-imagery',
    ]),
    title: 'NASA GIBS',
    feeds:
      'IMAGERY — the orbital and science sensors: VIIRS, MODIS, Sentinel-1, Black Marble and more',
    url: 'https://www.earthdata.nasa.gov/engage/open-data-services-software-policies',
  }),
  Object.freeze({
    id: 'noaa-weather-models',
    layers: Object.freeze(['wind']),
    title: 'NOAA GFS · ECMWF IFS',
    feeds: 'Wind — 10 m forecast wind from either open model',
    url: 'https://www.ecmwf.int/en/forecasts/datasets/open-data',
  }),
  Object.freeze({
    id: 'noaa-nowcoast',
    layers: Object.freeze([
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
    ]),
    title: 'NOAA NOWCOAST',
    feeds:
      'Observed Weather — rain radar, satellite clouds and lightning density',
    url: 'https://nowcoast.noaa.gov',
  }),
  Object.freeze({
    id: 'nifc-wfigs',
    layers: Object.freeze(['fire-perimeters']),
    title: 'NIFC WFIGS · INCIWEB',
    feeds: 'Fire Perimeters — current interagency wildfire perimeters',
    url: 'https://data-nifc.opendata.arcgis.com',
    note: 'US coverage',
  }),
  Object.freeze({
    id: 'eumetview',
    layers: Object.freeze(['imagery-goes']),
    title: 'EUMETSAT EUMETVIEW',
    feeds:
      'IMAGERY — the geostationary ring: Meteosat, Himawari and the multimission composites',
    url: 'https://www.eumetsat.int/eumetsat-data-licensing',
  }),
  Object.freeze({
    id: 'satnogs',
    layers: Object.freeze(['satnogs']),
    title: 'SATNOGS NETWORK',
    feeds:
      'SatNOGS — volunteer satellite ground stations and their observation counts',
    url: 'https://network.satnogs.org',
    note: 'CC BY-SA 4.0 — the one share-alike source here',
  }),
  Object.freeze({
    id: 'gdelt',
    layers: Object.freeze(['conflict-reports']),
    title: 'GDELT PROJECT',
    feeds:
      "Conflict Reporting (Events 2.0) and the cockpit's fallback headlines (DOC 2.0)",
    url: 'https://www.gdeltproject.org/about.html#termsofuse',
    note: 'News-derived and unverified, by construction',
  }),
  Object.freeze({
    id: 'nasa-iss-stream',
    layers: Object.freeze(['satellites']),
    title: 'NASA ISS LIVE STREAM',
    feeds: 'The ISS LIVE chip on the satellites row',
    url: 'https://www.nasa.gov/nasalive',
    note: 'A stream, not a dedicated Earth camera',
  }),
  Object.freeze({
    id: 'openmhz',
    layers: Object.freeze(['scanner']),
    title: 'OPENMHZ',
    feeds:
      'Scanners — recorded police, fire and EMS radio from 460+ trunked systems',
    url: 'https://openmhz.com',
    note: 'Community project; the browser talks to it directly',
  }),
  Object.freeze({
    id: 'sdr-directory',
    layers: Object.freeze(['sdr']),
    title: 'WEB SDR DIRECTORY',
    feeds:
      'SDR Receivers — 1,300+ public KiwiSDR, OpenWebRX and WebSDR receivers (receiverbook.de and curated lists)',
    url: 'https://www.receiverbook.de',
    note: 'Bundled snapshot; each receiver streams from its own operator',
  }),
  Object.freeze({
    id: 'faa-nasr',
    layers: Object.freeze(['atc']),
    title: 'FAA NASR · OURAIRPORTS',
    feeds:
      'ATC — published tower, ground, approach, ATIS and Center frequencies; LiveATC opens in its own page',
    url: 'https://ourairports.com/data/',
    note: 'Bundled 28-day NASR cycle; no audio is ever relayed',
  }),
  Object.freeze({
    id: 'radio-browser',
    layers: Object.freeze(['radio']),
    title: 'RADIO BROWSER',
    feeds: 'Radio — the geolocated internet-radio station directory',
    url: 'https://www.radio-browser.info',
  }),
  Object.freeze({
    id: 'nasa-firms-live',
    layers: Object.freeze(['local-firms']),
    title: 'NASA FIRMS (SNAPSHOT)',
    feeds:
      'The bundled active-fire snapshot; the NASA FIRMS key above switches on the live feed',
    url: 'https://firms.modaps.eosdis.nasa.gov',
  }),
  Object.freeze({
    id: 'osm-services',
    layers: Object.freeze([
      'traffic',
      'directions',
      'alpr-cameras',
      'military-installations',
    ]),
    title: 'OPENSTREETMAP SERVICES',
    feeds:
      'Overpass for roads and installations, Photon and Nominatim for place search, OSRM (FOSSGIS) for Directions',
    url: 'https://operations.osmfoundation.org/policies/',
    note: 'ODbL data; each service has its own usage policy',
  }),
  Object.freeze({
    id: 'open-meteo',
    layers: Object.freeze([]),
    title: 'OPEN-METEO',
    feeds: 'Current weather in the cockpit and its local atmospheric effects',
    url: 'https://open-meteo.com/en/licence',
  }),
  Object.freeze({
    id: 'google-news-rss',
    layers: Object.freeze([]),
    title: 'GOOGLE NEWS RSS',
    feeds: 'Locality-matched headlines in the cockpit Regional News page',
    url: 'https://news.google.com',
  }),
  Object.freeze({
    id: 'public-cctv',
    layers: Object.freeze(['cctv']),
    title: 'PUBLIC TRAFFIC CAMERAS',
    feeds:
      'CCTV — Austin, TxDOT, Caltrans, TfL JamCams, Ontario 511, DriveBC, Calgary, NSW, Tallinn, Tarktee, Fintraffic, Warendorf',
    url: 'https://github.com/bilawalsidhu/gods-eye-view/blob/main/DATA_SOURCES.md',
    note: 'Twelve operators, each under its own open-data terms',
  }),
  Object.freeze({
    id: 'transit-gtfs',
    layers: Object.freeze(['transit']),
    title: 'TRANSIT AGENCIES (GTFS-RT)',
    feeds:
      'Transit — live vehicles from MBTA, CapMetro, Metro Transit, OVapi, Entur, TransLink and HSL',
    url: 'https://gtfs.org/documentation/realtime/reference/',
  }),
  Object.freeze({
    id: 'gbfs',
    layers: Object.freeze(['bikeshare']),
    title: 'GBFS (LYFT · BCYCLE)',
    feeds: 'Bikeshare availability across 32 cities',
    url: 'https://gbfs.org',
  }),
  Object.freeze({
    id: 'ofac-sdn',
    layers: Object.freeze(['ais-live-vessels']),
    title: 'US TREASURY OFAC',
    feeds: 'VESSEL WATCH — the sanctioned-vessel list, matched by MMSI only',
    url: 'https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists',
    note: 'Bundled snapshot of the SDN list',
  }),
  Object.freeze({
    id: 'bundled-reference',
    layers: Object.freeze([
      'local-datacenters',
      'local-dams',
      'place-names',
      'telegeography-submarine-cables',
      'bhote-koshi-2026',
      'bhote-koshi-locator',
    ]),
    title: 'BUNDLED REFERENCE DATA',
    feeds:
      'Datacenters and dams (OSM), Natural Earth regions, countries and populated places, TeleGeography submarine cables, SF neighborhoods',
    url: 'https://github.com/bilawalsidhu/gods-eye-view/blob/main/DATA_SOURCES.md',
    note: 'TeleGeography is CC BY-NC-SA — non-commercial',
  }),
]);

/** Hostnames a Provider Settings request may arrive under or originate from. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Socket addresses that count as this machine. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Parse an exact local request authority from a Host header. */
function localAuthority(hostHeader, protocol) {
  const raw = String(hostHeader || '')
    .trim()
    .toLowerCase();
  const scheme = String(protocol || '').toLowerCase();
  if (!raw || !['http:', 'https:'].includes(scheme) || /[\s/?#@]/.test(raw))
    return null;
  try {
    const parsed = new URL(`${scheme}//${raw}`);
    return LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase())
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** True only for a subprocess that exited normally and successfully. */
export function commandCompletedSuccessfully(result) {
  return !!result && !result.error && !result.signal && result.status === 0;
}

/** Parse one RFC-4180-shaped CSV record, sufficient for `whoami /fo csv`. */
function parseCsvRecord(text) {
  const source = String(text || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!source || /[\r\n]/.test(source)) return null;
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

/**
 * Extract the current token's user SID from `whoami /user /fo csv /nh`.
 * The SID must be the second CSV field and a user-shaped local/domain or Entra
 * SID; matching an SID-looking account name or a broad group SID is forbidden.
 */
export function parseWindowsUserSid(stdout) {
  const fields = parseCsvRecord(stdout);
  if (!fields || fields.length !== 2) return null;
  const sid = fields[1].trim();
  return /^(?:S-1-5-21-(?:\d+-){3}\d+|S-1-12-1-(?:\d+-){3}\d+)$/i.test(sid)
    ? sid
    : null;
}

/**
 * The admission gate for the Provider Settings endpoints — pure, exported so
 * every refusal below is pinned by a unit assertion rather than a review note.
 *
 * Why each check exists:
 *  - sharing signals: any tunnel/LAN sharing mode disables the surface
 *    outright — a credential-writing endpoint has no business existing on a
 *    shared instance, and tunnel traffic reaches the server FROM loopback, so
 *    the socket check below cannot carry that boundary alone;
 *  - loopback socket: refuses LAN peers when the server is bound wide;
 *  - local Host header: tunnel and DNS-rebinding traffic carries a foreign
 *    Host even when the socket says loopback;
 *  - exact same Origin on POST: a hostile web page can make a browser POST to
 *    localhost, and a non-browser caller must not bypass that boundary merely
 *    by omitting the header;
 *  - JSON Content-Type on POST: forces cross-origin browsers into a CORS
 *    preflight this server never answers, closing the simple-request CSRF
 *    write primitive.
 *
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function admitKeySetupRequest({
  method,
  remoteAddress,
  hostHeader,
  protocol = 'http:',
  origin,
  contentType,
  proxyHeaders = {},
  env = {},
} = {}) {
  // A request carrying reverse-proxy / CDN forwarding headers did not originate
  // on this machine, whatever its socket says. Refuse them outright as defense
  // in depth — the shipped tunnel (Pinokio) is force-closed at boot, so these
  // only appear when someone has deliberately fronted the dev server.
  const PROXY_SIGNALS = [
    'forwarded',
    'via',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
    'x-real-ip',
    'cf-connecting-ip',
    'cf-ray',
  ];
  if (
    PROXY_SIGNALS.some((name) => String(proxyHeaders[name] || '').trim() !== '')
  ) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings does not answer proxied requests',
    };
  }
  // Every sharing signal the launcher recognizes (scripts/pinokio-preflight.mjs)
  // also disables this surface — so the gate's set is complete, not a subset the
  // two files could drift apart on. One DELIBERATE divergence: preflight is a
  // boot check that treats an empty PINOKIO_SHARE_VAR as sharing-on (fail closed
  // before Start), but here an empty/unset value is the NORMAL git-clone and
  // Pinokio state — treating it as sharing would disable Provider Settings for
  // every ordinary launch. So a bare/sentinel value is not sharing; only a real
  // tunnel var is. This is defense in depth regardless: the loopback+Host checks
  // below independently refuse LAN/tunnel traffic, and under Pinokio the launcher
  // refuses to boot at all when sharing is genuinely on.
  const shareVar = String(env.PINOKIO_SHARE_VAR ?? '').trim();
  const sharingEnabled =
    ['PINOKIO_SHARE_CLOUDFLARE', 'PINOKIO_SHARE_LOCAL'].some((name) =>
      /^(1|true)$/i.test(String(env[name] || '').trim()),
    ) ||
    (shareVar !== '' && shareVar !== '__gev_sharing_disabled__');
  if (sharingEnabled) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings is disabled while sharing is enabled',
    };
  }
  if (!LOOPBACK_ADDRESSES.has(String(remoteAddress || ''))) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings answers only the machine running the server',
    };
  }
  const authority = localAuthority(hostHeader, protocol);
  if (!authority) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings answers only local hostnames',
    };
  }
  if (
    method === 'POST' &&
    (origin === undefined || origin === null || origin === '')
  ) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings requires an exact local Origin',
    };
  }
  if (origin !== undefined && origin !== null && origin !== '') {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      return { ok: false, status: 403, error: 'Unrecognized Origin refused' };
    }
    const exactOrigin =
      parsedOrigin.username === '' &&
      parsedOrigin.password === '' &&
      parsedOrigin.pathname === '/' &&
      parsedOrigin.search === '' &&
      parsedOrigin.hash === '' &&
      parsedOrigin.origin === authority;
    if (!exactOrigin) {
      return {
        ok: false,
        status: 403,
        error: 'Cross-origin requests are refused',
      };
    }
  }
  if (
    method === 'POST' &&
    !String(contentType || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    return {
      ok: false,
      status: 415,
      error: 'Content-Type must be application/json',
    };
  }
  return { ok: true };
}

/** @returns {Set<string>} every env var the panel is allowed to write. */
export function knownKeySetupEnvVars() {
  const names = new Set();
  for (const entry of KEY_SETUP_KEYS) {
    for (const envVar of entry.envVars) names.add(envVar);
  }
  return names;
}

/** Tooltip guidance for a control gated by one registry entry. */
export function keySetupRequirement(id) {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  if (!entry || entry.hidden) return '';
  return `Needs ${entry.envVars.join(' + ')} — add it in Provider Settings`;
}

/**
 * Decide whether a live provider value belongs to a source outside the store
 * Provider Settings is allowed to edit. `wasExternalAtBoot` carries source
 * provenance without carrying the credential itself; it closes the otherwise
 * undecidable case where an exported value and a dotenv assignment happen to
 * contain the same bytes.
 * @param {{effectiveValue: unknown, storedValue: unknown, wasExternalAtBoot?: boolean}} input
 */
export function isKeySetupExternallyManaged({
  effectiveValue,
  storedValue,
  wasExternalAtBoot = false,
} = {}) {
  const effective = String(effectiveValue ?? '').trim();
  const stored = String(storedValue ?? '').trim();
  return effective !== '' && (wasExternalAtBoot || effective !== stored);
}

/**
 * Build the status payload the panel renders from: the registry, plus
 * per-entry `set` resolved against the given environment. It never includes
 * a value, suffix, or other credential material.
 * @param {Record<string, string|undefined>} env e.g. process.env
 */
export function keySetupStatus(env = {}) {
  const keys = KEY_SETUP_KEYS.filter((entry) => !entry.hidden).map((entry) => {
    const values = entry.envVars.map((name) => String(env[name] ?? '').trim());
    const set = values.every((value) => value.length > 0);
    return {
      id: entry.id,
      title: entry.title,
      unlocks: entry.unlocks,
      getUrl: entry.getUrl,
      envVars: [...entry.envVars],
      tier: entry.tier,
      clientExposed: Boolean(entry.clientExposed),
      set,
    };
  });
  return {
    keys,
    setCount: keys.filter((key) => key.set).length,
    total: keys.length,
    // Keyless services ride along so the panel can list what is already on.
    // They are not keys: nothing to set, nothing to count.
    keyless: KEY_SETUP_KEYLESS_SOURCES.map((entry) => ({
      id: entry.id,
      title: entry.title,
      feeds: entry.feeds,
      url: entry.url,
      note: entry.note || '',
    })),
  };
}

/**
 * Validate a POST body into a clean {ENV_VAR: value} map, or say exactly why
 * not. Values must be single-line printable ASCII with no spaces — every real
 * provider credential is — which is also what makes the raw `KEY=value` line
 * below safe to write without quoting rules. A `null` value means REMOVE:
 * the writer comments the assignment back out, returning the file to its
 * template state for that key.
 * @param {unknown} body Parsed JSON from the request.
 */
export function validateKeySetupUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: 'Body must be a JSON object of {ENV_VAR: value}',
    };
  }
  const entries = Object.entries(body);
  if (entries.length === 0) return { ok: false, error: 'No keys provided' };
  if (entries.length > KEY_SETUP_UPDATE_LIMIT) {
    return {
      ok: false,
      error: `At most ${KEY_SETUP_UPDATE_LIMIT} keys per save`,
    };
  }
  const known = knownKeySetupEnvVars();
  const updates = {};
  for (const [name, raw] of entries) {
    if (!known.has(name)) return { ok: false, error: `Unknown key: ${name}` };
    if (raw === null) {
      updates[name] = null;
      continue;
    }
    if (typeof raw !== 'string')
      return { ok: false, error: `${name} must be a string` };
    const value = raw.trim();
    if (!value) return { ok: false, error: `${name} is empty` };
    if (value.length > KEY_SETUP_VALUE_LIMIT) {
      return {
        ok: false,
        error: `${name} is longer than any real key (${KEY_SETUP_VALUE_LIMIT} max)`,
      };
    }
    if (!/^[\x21-\x7e]+$/.test(value)) {
      return {
        ok: false,
        error: `${name} may only contain printable characters with no spaces`,
      };
    }
    // Reject the dotenv metacharacters that would round-trip WRONG when written
    // unquoted (# starts a comment, quotes redelimit, $ expands, backslash and
    // backtick are escapes) — so a saved value can never differ from what Node's
    // parseEnv and Vite's expansion read back. Real provider keys never contain
    // these; they are base64url / hex / JWT alphabets.
    if (/[#"'$\\`]/.test(value)) {
      return {
        ok: false,
        error: `${name} contains a character that is not valid in a key (#, quotes, $, \\, or backtick)`,
      };
    }
    updates[name] = value;
  }
  return { ok: true, updates };
}

/**
 * Upsert `KEY=value` lines into dotenv text, disturbing nothing else.
 *
 * Placement, per key: the LAST active assignment is replaced in place (last
 * is what dotenv parsing lets win); failing that, the last commented-out
 * assignment is uncommented in place, so a file copied from .env.example
 * keeps its curated shape; failing both, the line is appended at the end
 * under one shared header. Every untouched line — comments, blanks, other
 * keys — survives byte for byte, and the result always ends in a newline.
 *
 * A `null` value REMOVES: every active assignment for that key is commented
 * back out (`# KEY=`), returning the file to its template shape; a key with
 * no active assignment is left untouched.
 * @param {string} text Existing file content ('' births a new file).
 * @param {Record<string, string|null>} updates Validated {ENV_VAR: value} map.
 */
export function upsertDotenvValues(text, updates) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.length ? source.split(/\r?\n/) : [];
  const additions = [];
  for (const [name, value] of Object.entries(updates)) {
    const active = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*(?:export\\s+)?${name}\\s*=`);
    if (value === null) {
      lines.forEach((line, index) => {
        if (active.test(line)) lines[index] = `# ${name}=`;
      });
      continue;
    }
    const assignment = `${name}=${value}`;
    let lastActive = -1;
    let lastCommented = -1;
    lines.forEach((line, index) => {
      if (active.test(line)) lastActive = index;
      else if (commented.test(line)) lastCommented = index;
    });
    if (lastActive >= 0) lines[lastActive] = assignment;
    else if (lastCommented >= 0) lines[lastCommented] = assignment;
    else additions.push(assignment);
  }
  if (additions.length) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (!lines.some((line) => line.trim() === KEY_SETUP_APPEND_HEADER)) {
      if (lines.length) lines.push('');
      lines.push(KEY_SETUP_APPEND_HEADER);
    }
    lines.push(...additions);
  }
  const joined = lines.join('\n');
  if (!joined) return '';
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

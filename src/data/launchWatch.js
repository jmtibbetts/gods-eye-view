/**
 * Launch watch — the next launches as countdowns, with the honest way to see
 * and hear each one.
 *
 * Everything here is pure: Launch Library 2's upcoming feed in, records the
 * LAUNCH panel can render out. The record says when a launch is (its net,
 * and how firm that is), what state it is in (a countdown, a hold, in
 * flight, flown), and where its webcast lives — embedded when the publisher
 * allows framing, otherwise opened on the publisher's own page.
 *
 * What it does not do is invent telemetry. Launch Library carries no live
 * vehicle position, so the globe shows the pad and the clock; the picture of
 * the rocket is the webcast, and the mission nets you hear on it are the
 * operator's own loops mixed into the stream — not a public band anyone can
 * tune. What a radio near the range CAN hear is worked out in the panel
 * from the scanner, airband and web-SDR directories, and labelled as such.
 */

/** How long after net a flown launch stays on the list. */
export const LAUNCH_WATCH_FLOWN_LINGER_MS = 3 * 3600_000;
/** Inside this window a countdown reads as imminent. */
export const LAUNCH_WATCH_IMMINENT_MS = 30 * 60_000;
/** After net, with no update yet, a "Go" launch is assumed flying this long. */
export const LAUNCH_WATCH_FLYING_ASSUMED_MS = 20 * 60_000;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

/**
 * The frameable form of a webcast URL, or null when the publisher's page
 * cannot be embedded (X, NASA+, most operator sites). YouTube is framed
 * through the tracking-free host the receiver dock already allows.
 * @param {string} value
 * @returns {string|null}
 */
export function webcastEmbedUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  let id = null;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (url.pathname === '/watch') id = url.searchParams.get('v');
  else {
    const m = url.pathname.match(/^\/(?:embed|live|shorts)\/([^/?#]+)/);
    if (m) id = m[1];
  }
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
}

/** A finite number, or null — and null, undefined and '' are null, not 0. */
function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** LL2 marks an unknown launch probability as null or -1; only 0–100 is one. */
function probability(value) {
  const n = finite(value);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}

function isoOrNull(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Normalise a Launch Library 2 response (list or `{results}`) into watch
 * records, newest-first is NOT the order: they come back sorted by net.
 * Launches with no pad coordinates are kept — a countdown is still a
 * countdown — but flagged so the panel offers no FLY TO.
 * @param {object|Array} payload
 * @returns {Array<object>}
 */
export function normalizeLaunchWatch(payload) {
  const launches = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(launches)) return [];
  return launches
    .map((launch) => {
      if (!launch || typeof launch !== 'object') return null;
      const pad = launch.pad || {};
      const location = pad.location || {};
      const net = isoOrNull(launch.net);
      const webcasts = (Array.isArray(launch.vid_urls) ? launch.vid_urls : [])
        .map((v) => ({
          title: v?.title || v?.publisher || 'Webcast',
          publisher: v?.publisher || v?.source || null,
          source: v?.source || null,
          url: typeof v?.url === 'string' ? v.url : null,
          embedUrl: webcastEmbedUrl(v?.url),
          live: v?.live === true,
          startTime: isoOrNull(v?.start_time),
          priority: finite(v?.priority) ?? 0,
          language: v?.language?.code || null,
        }))
        .filter((v) => v.url)
        .sort((a, b) => {
          // Live first, then framable, then the publisher's own ranking.
          if (a.live !== b.live) return a.live ? -1 : 1;
          if (Boolean(a.embedUrl) !== Boolean(b.embedUrl))
            return a.embedUrl ? -1 : 1;
          return b.priority - a.priority;
        });
      const updates = Array.isArray(launch.updates) ? launch.updates : [];
      const latest = updates
        .map((u) => ({
          comment: u?.comment || '',
          at: isoOrNull(u?.created_on),
          by: u?.created_by || null,
        }))
        .filter((u) => u.comment)
        .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))[0];
      return {
        id: String(launch.id || launch.slug || launch.name || net || ''),
        name: launch.name || 'Unnamed launch',
        provider: launch.launch_service_provider?.name || null,
        providerAbbrev: launch.launch_service_provider?.abbrev || null,
        rocket: launch.rocket?.configuration?.full_name || null,
        status: {
          abbrev: launch.status?.abbrev || 'TBD',
          name: launch.status?.name || 'Unknown',
          description: launch.status?.description || null,
        },
        net,
        netPrecision: launch.net_precision?.name || null,
        windowStart: isoOrNull(launch.window_start),
        windowEnd: isoOrNull(launch.window_end),
        probability: probability(launch.probability),
        weatherConcerns: launch.weather_concerns || null,
        holdReason: launch.holdreason || null,
        failReason: launch.failreason || null,
        webcastLive: launch.webcast_live === true,
        webcasts,
        padName: pad.name || null,
        siteName: location.name || null,
        country:
          location.country?.alpha_2_code || location.country_code || null,
        lat: finite(pad.latitude),
        lon: finite(pad.longitude),
        missionName: launch.mission?.name || null,
        missionDescription: launch.mission?.description || null,
        orbit: launch.mission?.orbit?.name || null,
        latestUpdate: latest || null,
        image: launch.image?.thumbnail_url || launch.image?.image_url || null,
        infoUrls: (Array.isArray(launch.info_urls) ? launch.info_urls : [])
          .map((u) => (typeof u?.url === 'string' ? u.url : null))
          .filter(Boolean),
      };
    })
    .filter((r) => r && r.id)
    .sort((a, b) => Date.parse(a.net || 0) - Date.parse(b.net || 0));
}

const FLOWN = new Set(['Success', 'Failure', 'Partial Failure']);

/**
 * Where a launch is on the clock right now.
 * @param {object} record
 * @param {number} nowMs
 * @returns {'flying'|'flown'|'hold'|'imminent'|'countdown'|'tbd'}
 */
export function launchPhase(record, nowMs) {
  const abbrev = record?.status?.abbrev || 'TBD';
  if (abbrev === 'In Flight') return 'flying';
  if (FLOWN.has(abbrev)) return 'flown';
  if (abbrev === 'Hold') return 'hold';
  const net = Date.parse(record?.net || '');
  if (!Number.isFinite(net)) return 'tbd';
  const dt = net - nowMs;
  if (dt <= 0) {
    // Net has passed and the editors have not caught up: a Go launch is
    // most likely flying; a TBD/TBC one has most likely slipped.
    return abbrev === 'Go' && -dt <= LAUNCH_WATCH_FLYING_ASSUMED_MS
      ? 'flying'
      : 'tbd';
  }
  if (abbrev === 'TBD') return 'tbd';
  return dt <= LAUNCH_WATCH_IMMINENT_MS ? 'imminent' : 'countdown';
}

/** Records worth listing: not flown more than a few hours ago. */
export function watchableLaunches(records, nowMs) {
  return (records || []).filter((r) => {
    const net = Date.parse(r?.net || '');
    if (launchPhase(r, nowMs) !== 'flown') return true;
    return Number.isFinite(net) && nowMs - net <= LAUNCH_WATCH_FLOWN_LINGER_MS;
  });
}

/**
 * Sort for the list: flying first, then imminent, then by net, holds and
 * TBDs in net order after firm countdowns, flown last.
 */
export function sortForWatch(records, nowMs) {
  const rank = {
    flying: 0,
    imminent: 1,
    countdown: 2,
    hold: 3,
    tbd: 4,
    flown: 5,
  };
  return [...(records || [])].sort((a, b) => {
    const ra = rank[launchPhase(a, nowMs)];
    const rb = rank[launchPhase(b, nowMs)];
    if (ra !== rb) return ra - rb;
    return Date.parse(a.net || 0) - Date.parse(b.net || 0);
  });
}

/**
 * "T−01:23:45" / "T+00:03:10" / "T−2d 04:00:00"; null with no net.
 * @param {string|null} net ISO time
 * @param {number} nowMs
 */
export function countdownText(net, nowMs) {
  const t = Date.parse(net || '');
  if (!Number.isFinite(t)) return null;
  const diff = Math.round((t - nowMs) / 1000);
  const sign = diff < 0 ? '+' : '−';
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return days > 0 ? `T${sign}${days}d ${hms}` : `T${sign}${hms}`;
}

/** One line for the status chip. */
export function phaseLabel(phase, record) {
  switch (phase) {
    case 'flying':
      return 'IN FLIGHT';
    case 'flown':
      return (record?.status?.abbrev || 'FLOWN').toUpperCase();
    case 'hold':
      return 'HOLD';
    case 'imminent':
      return 'IMMINENT';
    case 'countdown':
      return (record?.status?.abbrev || 'GO').toUpperCase() === 'TBC'
        ? 'TO BE CONFIRMED'
        : 'GO';
    default:
      return 'DATE TBD';
  }
}

/** The one webcast to offer: the live one, else the first framable, else the first. */
export function primaryWebcast(record) {
  return record?.webcasts?.[0] || null;
}

/** The distance between two points on the ground, km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** VHF airband, the one band a range's public traffic is actually on. */
export const AIRBAND_HZ = Object.freeze([118_000_000, 137_000_000]);

/**
 * What a listener near the pad can actually hear, from the radio
 * directories the app already carries. Every entry says what it is; the
 * panel never implies a countdown net is on any of them.
 * @param {object} record A launch watch record with lat/lon.
 * @param {object} directories
 * @param {Array<object>} [directories.scannerSystems] OpenMHz systems near the pad (with distanceKm).
 * @param {Array<object>} [directories.airports] ATC airports near the pad (with distanceKm, freqs).
 * @param {Array<object>} [directories.receivers] Web SDRs near the pad (with distanceKm, bands/ranges).
 * @returns {{scanner: Array, airband: Array, sdr: Array}}
 */
export function listenSourcesFor(record, directories = {}) {
  const out = { scanner: [], airband: [], sdr: [] };
  if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon))
    return out;
  for (const s of directories.scannerSystems || []) {
    if (!(s.distanceKm <= 120)) continue;
    out.scanner.push({
      id: s.id,
      name: s.name,
      place: s.place || [s.county, s.state].filter(Boolean).join(', '),
      distanceKm: s.distanceKm,
      callAvg: finite(s.callAvg) ?? 0,
      // A trunked system on the range itself is the one worth naming first.
      onRange: /space|nasa|launch|canaveral|kennedy|vandenberg|wallops/i.test(
        `${s.name} ${s.desc || ''}`,
      ),
    });
  }
  out.scanner.sort(
    (a, b) =>
      Number(b.onRange) - Number(a.onRange) || a.distanceKm - b.distanceKm,
  );
  for (const a of directories.airports || []) {
    if (!(a.distanceKm <= 60)) continue;
    const freqs = (a.freqs || [])
      .filter(
        (f) =>
          !f.secondary && ['TWR', 'APP', 'GND', 'CTAF'].includes(f.position),
      )
      .map((f) => ({ position: f.position, mhz: f.mhz }));
    if (!freqs.length) continue;
    out.airband.push({
      id: a.id,
      name: a.name,
      call: a.call || null,
      towered: Boolean(a.towered),
      distanceKm: a.distanceKm,
      freqs,
      // Airfields on the range: the pad's own tower and the strip next door.
      onRange:
        /space|nasa|launch|canaveral|kennedy|vandenberg|wallops|skid strip|cape/i.test(
          a.name || '',
        ),
    });
  }
  out.airband.sort(
    (a, b) =>
      Number(b.onRange) - Number(a.onRange) ||
      Number(b.towered) - Number(a.towered) ||
      a.distanceKm - b.distanceKm,
  );
  for (const r of directories.receivers || []) {
    if (!(r.distanceKm <= 250)) continue;
    const ranges =
      Array.isArray(r.ranges) && r.ranges.length
        ? r.ranges
        : r.bands
          ? [r.bands]
          : [];
    const coversAirband = ranges.some(
      (range) => range[0] <= AIRBAND_HZ[0] && range[1] >= AIRBAND_HZ[1],
    );
    const hfOnly =
      ranges.length > 0 && ranges.every((range) => range[1] <= 30_000_000);
    out.sdr.push({
      id: r.id,
      name: r.name,
      type: r.type,
      url: r.url,
      distanceKm: r.distanceKm,
      coversAirband,
      hfOnly,
      rangeKnown: ranges.length > 0,
    });
  }
  out.sdr.sort(
    (a, b) =>
      Number(b.coversAirband) - Number(a.coversAirband) ||
      a.distanceKm - b.distanceKm,
  );
  return out;
}

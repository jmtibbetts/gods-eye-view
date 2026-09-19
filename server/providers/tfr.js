/**
 * Temporary flight restrictions — the FAA's TFR list with its shapes.
 *
 * tfr.faa.gov publishes three things that together make a TFR: a LIST
 * (`tfrapi/getTfrList`: NOTAM number, type, ARTCC, state, a title that
 * carries the dates in prose), the SHAPES (a GeoServer WFS layer, one
 * polygon per area, keyed by NOTAM number), and per NOTAM a DETAIL page
 * (`tfrapi/getWebText`) that is the only place the effective times, the
 * altitude block and the reason live. None of them sends CORS headers, so
 * the browser reads them through here.
 *
 * The detail page is fetched only for SPACE OPERATIONS restrictions: those
 * are the ones a launch watcher needs to the minute (a closure opens hours
 * before a window and the pad is on the globe already), and there are a
 * handful of them where there are a hundred security and hazard TFRs. The
 * rest keep the day-level dates parsed out of their titles, and say so.
 *
 * Routes:
 *   GET /api/aviation/tfrs → { fetchedAt, tfrs: [record] }
 */

import { cachedJsonEndpoint } from './cachedEndpoint.js';

export const TFR_LIST_URL = 'https://tfr.faa.gov/tfrapi/getTfrList';
export const TFR_SHAPES_URL =
  'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=1000&outputFormat=application/json&srsname=EPSG:4326';
export const tfrTextUrl = (notamId) =>
  `https://tfr.faa.gov/tfrapi/getWebText?notamId=${encodeURIComponent(notamId)}`;
/** The FAA's own page for a NOTAM, for the reader who wants the full text. */
export const tfrPageUrl = (notamId) =>
  `https://tfr.faa.gov/tfr3/?page=detail_${String(notamId).replace('/', '_')}`;

/** TFRs are issued and cancelled through the day; ten minutes is timely. */
export const TFR_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 25_000;
/** Detail pages fetched per refresh — space operations only, and never a flood. */
export const TFR_DETAIL_LIMIT = 12;
export const TFR_DETAIL_TYPE = 'SPACE OPERATIONS';

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/** "6/2736-1-FDC-F" → "6/2736"; "6/2736" → "6/2736". */
export function notamIdOf(key) {
  const m = String(key ?? '').match(/^(\d+\/\d+)/);
  return m ? m[1] : null;
}

/**
 * "September 20, 2026 at 1400 UTC" → ISO instant; "September 20, 2026" →
 * midnight UTC of that day. Anything else → null. The FAA writes every
 * detail-page time in UTC; the list titles say "UTC" or "Local" after the
 * dates, and a local date is still returned as the calendar day.
 */
export function parseFaaDate(text) {
  const m = String(text ?? '').match(
    /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+at\s+(\d{2})(\d{2})\s*UTC)?/,
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const t = Date.UTC(year, month, day, hour, minute);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The day-level window out of a list title: the first and last
 * "Month D, YYYY" in it. A one-day TFR names one date, and it is both.
 * @returns {{begins:string|null, ends:string|null, local:boolean}}
 */
export function windowFromTitle(title) {
  const text = String(title ?? '');
  const dates = [...text.matchAll(/[A-Za-z]+\s+\d{1,2},\s+\d{4}/g)].map((m) =>
    parseFaaDate(m[0]),
  );
  const begins = dates[0] ?? null;
  const last = dates.length ? dates[dates.length - 1] : null;
  // A day-level end means "through that day": the end of it, not its start.
  const ends = last
    ? new Date(Date.parse(last) + 86_400_000 - 60_000).toISOString()
    : null;
  return { begins, ends, local: /\bLocal\b/.test(text) };
}

/** Strip a detail page to one line of plain text. */
function plainText(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function field(text, label, stop) {
  const re = new RegExp(`${label}\\s*:\\s*(.*?)\\s*(?=${stop})`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/**
 * The parts of a NOTAM detail page a watcher needs, from its HTML.
 * @param {string} html The `text` of a getWebText row.
 * @returns {{begins:string|null, ends:string|null, altitude:string|null,
 *   reason:string|null, location:string|null, contact:string|null,
 *   issued:string|null}}
 */
export function parseTfrText(html) {
  const text = plainText(html);
  const beginsText = field(
    text,
    'Beginning Date and Time',
    'Ending Date and Time',
  );
  const endsText = field(text, 'Ending Date and Time', 'Reason for NOTAM');
  const reason = field(text, 'Reason for NOTAM', 'Type\\s*:');
  const location = field(text, 'Location', 'Beginning Date and Time');
  const issued = field(text, 'Issue Date', 'Location\\s*:');
  const altitude = field(
    text,
    'Altitude',
    'Effective Date\\(s\\)|ENDSECTION|Operating Restrictions',
  );
  const contact = field(text, 'Pilots May Contact', 'Jump To|Affected Area');
  return {
    begins: parseFaaDate(beginsText),
    ends: parseFaaDate(endsText),
    altitude: altitude || null,
    reason: reason || null,
    location: location || null,
    contact: contact || null,
    issued: parseFaaDate(issued),
  };
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A GeoJSON Polygon's outer ring as a flat [lon, lat, …], or null. */
function outerRing(geometry) {
  if (geometry?.type !== 'Polygon') return null;
  const ring = geometry.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const flat = [];
  for (const point of ring) {
    const lon = number(point?.[0]);
    const lat = number(point?.[1]);
    if (lon === null || lat === null || Math.abs(lat) > 90) return null;
    if (Math.abs(lon) > 180) return null;
    // Five decimals is a metre; the WFS sends eight, which is a third of
    // the payload for nothing.
    flat.push(Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5);
  }
  return flat.length >= 8 ? flat : null;
}

/**
 * The middle of a flat ring's bounding box — good enough to say where a
 * closure is, and unlike a vertex mean not pulled towards wherever the
 * FAA's digitiser put the closing point.
 */
export function ringCentre(flat) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    west = Math.min(west, flat[i]);
    east = Math.max(east, flat[i]);
    south = Math.min(south, flat[i + 1]);
    north = Math.max(north, flat[i + 1]);
  }
  return {
    lat: Math.round(((south + north) / 2) * 1e4) / 1e4,
    lon: Math.round(((west + east) / 2) * 1e4) / 1e4,
  };
}

/** "202609141210" → ISO. */
function absTimeToIso(value) {
  const m = String(value ?? '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * One record per NOTAM: the list row, every shape that carries its number,
 * and the detail where one was fetched. A NOTAM in the list with no shape is
 * kept with no areas — the layer cannot draw it, but the LAUNCH panel can
 * still say a closure is published. A shape with no list row is dropped: the
 * list is the authority on what is in force.
 * @param {Array<object>} list getTfrList rows.
 * @param {object} shapes WFS GeoJSON FeatureCollection.
 * @param {Map<string, object>} [details] notam id → parseTfrText result.
 */
export function mergeTfrs(list, shapes, details = new Map()) {
  const areasById = new Map();
  for (const feature of shapes?.features || []) {
    const id = notamIdOf(feature?.properties?.NOTAM_KEY);
    const ring = outerRing(feature?.geometry);
    if (!id || !ring) continue;
    if (!areasById.has(id)) areasById.set(id, []);
    areasById.get(id).push({
      gid: number(feature.properties?.GID) ?? areasById.get(id).length + 1,
      ring,
      centre: ringCentre(ring),
    });
  }
  const out = [];
  for (const row of Array.isArray(list) ? list : []) {
    const id = notamIdOf(row?.notam_id);
    if (!id) continue;
    const type = String(row.type || 'OTHER')
      .trim()
      .toUpperCase();
    const title = String(row.description || '').trim();
    const fromTitle = windowFromTitle(title);
    const detail = details.get(id) || null;
    const areas = areasById.get(id) || [];
    out.push({
      id,
      type,
      facility: row.facility || null,
      state: row.state || null,
      title,
      modifiedAt: absTimeToIso(row.mod_abs_time),
      begins: detail?.begins ?? fromTitle.begins,
      ends: detail?.ends ?? fromTitle.ends,
      // Whether begins/ends are the NOTAM's own instants or a day parsed
      // out of the title.
      timesExact: Boolean(detail?.begins && detail?.ends),
      localTime: fromTitle.local,
      altitude: detail?.altitude ?? null,
      reason: detail?.reason ?? null,
      location: detail?.location ?? null,
      contact: detail?.contact ?? null,
      areas,
      centre: areas.length ? areas[0].centre : null,
      pageUrl: tfrPageUrl(id),
    });
  }
  return out;
}

async function getJson(url, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json', 'user-agent': 'gods-eye-view' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * List and shapes together, then the detail pages for the space closures.
 * Either of the first two failing is a failure; a detail page failing just
 * leaves that record with its title dates.
 */
export function createTfrLoader({
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = TIMEOUT_MS,
  detailLimit = TFR_DETAIL_LIMIT,
  now = () => Date.now(),
} = {}) {
  return async function load() {
    const [list, shapes] = await Promise.all([
      getJson(TFR_LIST_URL, { fetchImpl, timeoutMs }),
      getJson(TFR_SHAPES_URL, { fetchImpl, timeoutMs }),
    ]);
    if (!Array.isArray(list)) throw new Error('TFR list is not a list');
    if (!Array.isArray(shapes?.features))
      throw new Error('TFR shapes are not a feature collection');
    const wanted = list
      .filter(
        (row) => String(row?.type || '').toUpperCase() === TFR_DETAIL_TYPE,
      )
      .map((row) => notamIdOf(row.notam_id))
      .filter(Boolean)
      .slice(0, detailLimit);
    const details = new Map();
    const settled = await Promise.allSettled(
      wanted.map((id) => getJson(tfrTextUrl(id), { fetchImpl, timeoutMs })),
    );
    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled') return;
      const text = Array.isArray(result.value)
        ? result.value[0]?.text
        : result.value?.text;
      if (typeof text === 'string') details.set(wanted[i], parseTfrText(text));
    });
    return {
      fetchedAt: new Date(now()).toISOString(),
      tfrs: mergeTfrs(list, shapes, details),
    };
  };
}

export function tfrProxy() {
  const tfrs = cachedJsonEndpoint({
    load: createTfrLoader(),
    ttlMs: TFR_TTL_MS,
    label: 'FAA TFRs',
    diskCache: `${process.cwd()}/.gev-cache/faa-tfrs-v1.json`,
  });

  function installMiddleware(server) {
    server.middlewares.use('/api/aviation/tfrs', tfrs);
  }

  return {
    name: 'gev-tfr-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

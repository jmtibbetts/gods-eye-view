import { ATC_POSITIONS } from './policy.js';

const POSITION_SET = new Set(ATC_POSITIONS);

/** Airport names are FAA/OurAirports authored; keep the words only. */
const text = (value, max = 80) => {
  const t = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\uFFFD\u0000-\u001F]/g, '')
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(t);
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : t;
};

const code = (value, max = 12) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, max);

/** VHF airband and the nav-band ATIS/AWOS voice channels (MHz). */
/** The VHF emergency frequency, listed at every Center site. */
const ATC_GUARD_MHZ = 121.5;

export function isAtcVhfMhz(mhz) {
  return Number.isFinite(mhz) && mhz >= 108 && mhz <= 137;
}

/**
 * Normalise one bundled frequency row: [position, MHz, sector?, secondary?].
 * @param {unknown} row
 * @returns {{position:string, mhz:number, sector:string, secondary:boolean}|null}
 */
export function normalizeAtcFrequency(row) {
  if (!Array.isArray(row)) return null;
  const position = code(row[0], 8);
  const mhz = Number(row[1]);
  if (!POSITION_SET.has(position) || !isAtcVhfMhz(mhz)) return null;
  return {
    position,
    mhz: Math.round(mhz * 1000) / 1000,
    sector: text(row[2], 40),
    secondary: Boolean(row[3]),
  };
}

function normalizeAirport(row) {
  if (!row || typeof row !== 'object') return null;
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  const id = code(row.id, 24);
  if (
    !id ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180
  )
    return null;
  const freqs = (Array.isArray(row.freqs) ? row.freqs : [])
    .map(normalizeAtcFrequency)
    .filter(Boolean);
  if (!freqs.length) return null;
  const tower = text(row.tower, 20);
  const hours = text(row.hours, 40);
  return {
    id,
    faa: code(row.faa, 6),
    name: text(row.name, 80) || id,
    city: text(row.city, 60),
    region: code(row.region, 8),
    country: code(row.country, 2),
    lat,
    lon,
    elevFt: Number.isFinite(row.elevFt) ? Math.round(row.elevFt) : null,
    site: code(row.site, 1) || 'A',
    /** Tower facility type ('' when untowered). */
    tower,
    towered: Boolean(tower) || freqs.some((f) => f.position === 'TWR'),
    hours,
    call: text(row.call, 40),
    appCall: text(row.appCall, 40),
    appProvider: code(row.appProvider, 6),
    freqs,
  };
}

function normalizeCenter(row) {
  if (!row || typeof row !== 'object') return null;
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  const id = code(row.id, 24);
  if (
    !id ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180
  )
    return null;
  // 121.5 is guard — the emergency frequency every site lists and no
  // controller works a sector on. A site that carries nothing else is the
  // facility's own entry, not a place a contact would be talking to.
  const freqs = (Array.isArray(row.freqs) ? row.freqs : [])
    .map((f) =>
      Array.isArray(f) &&
      isAtcVhfMhz(Number(f[0])) &&
      Math.abs(Number(f[0]) - ATC_GUARD_MHZ) > 0.0005
        ? {
            position: 'CTR',
            mhz: Math.round(Number(f[0]) * 1000) / 1000,
            sector: text(f[1], 40),
            secondary: false,
          }
        : null,
    )
    .filter(Boolean);
  if (!freqs.length) return null;
  return {
    id,
    artcc: code(row.artcc, 4),
    name: text(row.name, 60) || id,
    city: text(row.city, 60),
    region: code(row.region, 8),
    lat,
    lon,
    freqs,
  };
}

/**
 * Validate the bundled ATC directory. Bad rows are dropped one by one; a
 * payload without an airports array is rejected.
 * @param {unknown} payload Parsed airports.json.
 * @returns {{airports: object[], centers: object[]}|null}
 */
export function normalizeAtcDirectory(payload) {
  const rows = payload?.airports;
  if (!Array.isArray(rows)) return null;
  const airports = [];
  const seen = new Set();
  for (const row of rows) {
    const airport = normalizeAirport(row);
    if (!airport || seen.has(airport.id)) continue;
    seen.add(airport.id);
    airports.push(airport);
  }
  const centers = [];
  const seenCenters = new Set();
  for (const row of Array.isArray(payload?.centers) ? payload.centers : []) {
    const center = normalizeCenter(row);
    if (!center || seenCenters.has(center.id)) continue;
    seenCenters.add(center.id);
    centers.push(center);
  }
  return { airports, centers };
}

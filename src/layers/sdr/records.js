import { SDR_COLORS } from './policy.js';

/** Every KiwiSDR is a 0–30 MHz receiver by hardware; the directory rarely says so. */
const KIWISDR_BANDS = Object.freeze([0, 30_000_000]);

const text = (value, max = 90) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Only plain http(s) receiver pages with a hostname survive; anything with
 * credentials or an odd scheme is dropped. Receivers are volunteer boxes on
 * home connections, so plain http is normal and must be allowed.
 * @param {unknown} value
 * @returns {string|null}
 */
export function sdrReceiverUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || !url.hostname) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|0\.)/.test(url.hostname))
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Validate the bundled receiver directory. Bad rows are dropped one by one
 * (the file is a snapshot, not a feed), but a non-array payload is rejected.
 * @param {unknown} payload Parsed receivers.json.
 * @returns {Array<object>|null}
 */
export function normalizeSdrDirectory(payload) {
  const rows = payload?.receivers;
  if (!Array.isArray(rows)) return null;
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const url = sdrReceiverUrl(row.url);
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (
      !url ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180
    )
      continue;
    const id = text(row.id, 120) || url;
    if (seen.has(id)) continue;
    seen.add(id);
    const type = String(row.type || 'sdr').toLowerCase();
    const bands =
      Array.isArray(row.bands) &&
      Number.isFinite(row.bands[0]) &&
      Number.isFinite(row.bands[1])
        ? [Math.max(0, row.bands[0]), Math.max(0, row.bands[1])]
        : type === 'kiwisdr'
          ? KIWISDR_BANDS
          : null;
    out.push({
      id,
      name: text(row.name, 90) || id,
      url,
      lat,
      lon,
      type: Object.prototype.hasOwnProperty.call(SDR_COLORS, type)
        ? type
        : 'sdr',
      bands,
      antenna: text(row.antenna, 60) || null,
      hw: text(row.hw, 60) || null,
      usersMax: Number.isFinite(row.usersMax) ? Math.floor(row.usersMax) : null,
      src: text(row.src, 40) || null,
    });
  }
  return out;
}

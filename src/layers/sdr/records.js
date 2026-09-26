import { SDR_COLORS } from './policy.js';

/** Every KiwiSDR is a 0–30 MHz receiver by hardware; the directory rarely says so. */
const KIWISDR_BANDS = Object.freeze([0, 30_000_000]);

/** Receiver names are operator-authored; a few carry HTML. Keep the words only. */
const text = (value, max = 90) => {
  const t = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\uFFFD\u0000-\u001F]/g, '')
    // A lone surrogate half (an emoji cut in two upstream) renders as �.
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(t);
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : t;
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
 * The place a receiver's name claims, if it claims one.
 *
 * Operators name receivers freely — "W4JCW | Camden, South Carolina USA",
 * "0-30 MHz | Guipry-Messac, FRANCE", "K9DXI, Presque Isle, Wisconsin | USA"
 * — and the directory pins them wherever the operator put the marker, which
 * is not always the same place: the Camden receiver above is pinned near
 * Cape Canaveral, six hundred kilometres from Camden. This pulls the most
 * place-like segment out of a name so `scripts/check-sdr-places.mjs` can
 * geocode it and compare, and so the card can name what the name claims.
 *
 * Heuristic, and returns null rather than guess: a segment is a place when
 * it holds a comma-separated pair of words after the callsigns, frequency
 * ranges, locator squares, emoji and software names are stripped.
 * @param {string} name
 * @returns {string|null}
 */
export function sdrStatedPlace(name) {
  const cleaned = String(name ?? '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[►◀★☆▶◄»«]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?\s*[kmg]?hz\b/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*[kmg]hz\b/gi, ' ')
    .replace(
      /\b(?:kiwisdr|websdr|openwebrx|ubersdr|sdr|rx|hf|vhf|uhf|antenna|loop|dipole|active|airspy|rtl-?sdr|hackrf)\b\s*\d*/gi,
      ' ',
    )
    .replace(/\b[A-Z]{2}\d{2}[A-Z]{2}\b/g, ' ')
    .replace(/\b(?:[A-Z0-9]{1,2}\d[A-Z]{1,4}(?:\/[A-Z0-9]+)?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const segments = cleaned
    .split(/\s*[|~#@]\s*|\s+-\s+/)
    .map((seg) => seg.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim())
    .filter((seg) => seg.length >= 4);
  const placeLike = (seg) =>
    /^[\p{L}][\p{L}\s'.-]*,\s*[\p{L}][\p{L}\s'.()-]*$/u.test(seg) &&
    !/\d/.test(seg);
  const best = segments
    .filter(placeLike)
    .sort((a, b) => b.length - a.length)[0];
  return best ? best.replace(/\s*,\s*/g, ', ') : null;
}

/**
 * "W. Montana, USA" → "Montana, USA"; "Northern Virginia, USA" → "Virginia,
 * USA"; anything else → null. A geocoder answers "Montana" with the state
 * and "W. Montana" with nothing, so the audit tries this form second — and
 * only second, because "West Valley, OR" is a town, not the west of a valley.
 * @param {string|null} stated
 * @returns {string|null}
 */
export function sdrRegionWithoutDirection(stated) {
  const m = String(stated ?? '').match(
    /^(?:[NSEW]|NE|NW|SE|SW|North|South|East|West|Northern|Southern|Eastern|Western|Central)\.?\s+(?=[\p{L}])(.+)$/iu,
  );
  return m ? m[1] : null;
}

/** A bare address is whatever the box's connection happened to have that day. */
const isAddressLiteral = (hostname) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');

/** The port a receiver answers on, with the scheme default filled in. */
function sdrReceiverPort(url) {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return '';
  }
}

/**
 * Rank two addresses for the same radio. Lower wins.
 *  - https first: an http page will not embed beside a secure app.
 *  - a hostname before a bare IP: the operator maintains the name, and the
 *    address is whatever their ISP handed out that week.
 * Ties keep the directory's own order, so the choice is stable between loads.
 */
function sdrUrlRank(url) {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'https:' ? 0 : 2) + (isAddressLiteral(u.hostname) ? 1 : 0)
    );
  } catch {
    return 9;
  }
}

/**
 * One radio, one entry.
 *
 * Operators register the same box more than once — a dynamic-DNS name, the
 * kiwisdr.com proxy that reaches it from behind a carrier NAT, and the raw IP
 * all point at one receiver — so the bundled directory carries about 116 rows
 * more than there are radios and the globe stacks two to four markers on a
 * single pin.
 *
 * Rows fold only when the name, the position AND the port all match. A
 * different port on the same host is a second receiver instance — a separate
 * band, or a second box in the same shack — not a second way into the first,
 * so those stay apart. The addresses that lose are kept on the survivor as
 * `alternateUrls`: nothing is dropped, the entry just knows every way it can
 * be reached.
 *
 * Where the upstream data is wrong — two receivers in different towns sharing
 * one pin and one operator-written name — this folds them into one. That takes
 * nothing away that was visible: they shared a marker and a label before the
 * fold as well.
 *
 * @param {Array<object>} records - Validated receivers, in directory order.
 * @returns {Array<object>} One record per radio, each carrying its alternates.
 */
export function foldSdrDuplicates(records) {
  const byRadio = new Map();
  for (const record of records) {
    const key = [
      record.name,
      record.lat,
      record.lon,
      sdrReceiverPort(record.url),
    ].join('\u0000');
    const held = byRadio.get(key);
    if (!held) {
      byRadio.set(key, record);
      continue;
    }
    const [primary, alternate] =
      sdrUrlRank(record.url) < sdrUrlRank(held.url)
        ? [record, held]
        : [held, record];
    const alternateUrls = [
      ...(primary.alternateUrls || []),
      ...(alternate.alternateUrls || []),
      alternate.url,
    ].filter(
      (url, index, all) => url !== primary.url && all.indexOf(url) === index,
    );
    // A position warning outlives the fold. `check-sdr-places.mjs` derives the
    // mark from the name and the pin, which the folded rows share, so a copy
    // that lacks it was simply never audited — not cleared. Losing the warning
    // because the unmarked address happened to sort first would quietly turn
    // "this pin may be wrong" into silence, which is the one direction this
    // cleanup must not fail in.
    const marked =
      (alternate.placeMismatchKm || 0) > (primary.placeMismatchKm || 0)
        ? alternate
        : primary;
    byRadio.set(key, {
      ...primary,
      alternateUrls,
      placeMismatchKm: marked.placeMismatchKm,
      placeStated: marked.placeStated ?? primary.placeStated,
    });
  }
  return [...byRadio.values()];
}

/**
 * Validate the bundled receiver directory. Bad rows are dropped one by one
 * (the file is a snapshot, not a feed), but a non-array payload is rejected.
 * Rows that are the same radio under several addresses are folded by
 * {@link foldSdrDuplicates} before the directory is returned.
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
    const ranges = Array.isArray(row.ranges)
      ? row.ranges
          .filter(
            (r) =>
              Array.isArray(r) &&
              Number.isFinite(r[0]) &&
              Number.isFinite(r[1]) &&
              r[1] > r[0],
          )
          .map((r) => [Math.max(0, r[0]), r[1], text(r[2], 40)])
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
      bands:
        bands ||
        (ranges?.length
          ? [ranges[0][0], Math.max(...ranges.map((r) => r[1]))]
          : null),
      /** Per-profile tuning ranges [lowHz, highHz, name] when the receiver publishes them. */
      ranges: ranges?.length ? ranges : null,
      antenna: text(row.antenna, 60) || null,
      hw: text(row.hw, 60) || null,
      usersMax: Number.isFinite(row.usersMax) ? Math.floor(row.usersMax) : null,
      src: text(row.src, 40) || null,
      /**
       * Set by scripts/check-sdr-places.mjs when the place the name claims
       * geocodes far from the pin: the distance, km. A receiver so marked is
       * drawn where the directory put it but says its position is unverified,
       * and the LAUNCH panel leaves it out of "near the pad".
       */
      placeMismatchKm:
        Number.isFinite(row.placeKm) && row.placeKm > 0
          ? Math.round(row.placeKm)
          : null,
      placeStated: text(row.placeStated, 80) || null,
      /** The name is a product's shipped default (a KiwiSDR's "Tauranga"), not a claim. */
      placeDefault: row.placeDefault === true,
    });
  }
  return foldSdrDuplicates(out);
}

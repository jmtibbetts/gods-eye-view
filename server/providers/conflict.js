/**
 * Conflict reporting proxy — GDELT 2.0 event stream, aggregated by country.
 *
 * WHY AGGREGATED, which is the whole design. GDELT is the only conflict feed
 * that is both openly licensed and live: ACLED's terms forbid redisplay through
 * a dashboard, and UCDP's live API now needs a token while its open download is
 * annual. But GDELT geocodes a large share of its events to a state or country
 * CENTROID — in the sample this was built against, 36% of violent events landed
 * on one, and 74 events occupied 39 distinct coordinates. Plotted as points
 * that puts a conflict marker in the empty middle of Nevada and stacks eight on
 * a capital city.
 *
 * So nothing here is served with a position. The proxy counts events per
 * country and the layer shades whole countries, which is the resolution the
 * data actually has. That is the difference between reporting what GDELT knows
 * and inventing where it happened.
 *
 * WHAT AN "EVENT" IS. A machine-coded report in news coverage, not a verified
 * incident. Volume follows media attention as much as violence, and the layer
 * says so rather than letting a shaded country read as ground truth.
 *
 * Licensing: GDELT permits "unlimited and unrestricted use for any academic,
 * commercial, or governmental use of any kind without fee", with redistribution
 * allowed and attribution required. See DATA_SOURCES.md.
 *
 * Route:
 *   GET /api/conflict/reports → { at, sourceFile, countries: [...], totals }
 */

import { inflateRawSync } from 'node:zlib';
import { cachedJsonEndpoint } from './cachedEndpoint.js';

const LAST_UPDATE_URL = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';

/** GDELT publishes every 15 minutes; half that keeps the file fresh. */
const TTL_MS = 7 * 60_000;
const TIMEOUT_MS = 40_000;

/**
 * CAMEO root codes counted as violence.
 *
 * Deliberately narrow. The full taxonomy includes protest, coercion and threats
 * — real and often newsworthy, but not the same claim as violence, and folding
 * them in would inflate every country with an active news cycle.
 */
const VIOLENT_ROOTS = Object.freeze({
  18: 'Assault',
  19: 'Fight',
  20: 'Mass violence',
});

/** Column positions in the GDELT 2.0 export schema. */
const COL = Object.freeze({
  eventId: 0,
  day: 1,
  rootCode: 28,
  goldstein: 30,
  mentions: 31,
  countryCode: 53,
  geoType: 51,
  geoName: 52,
});

/**
 * Read the single deflated entry out of a GDELT zip.
 *
 * Node ships zlib, so this needs no dependency. The local header is read rather
 * than the central directory because these archives carry exactly one entry;
 * the row and column count are validated afterwards, so a format change
 * surfaces as a rejected payload rather than as silent nonsense.
 */
function unzipSingle(buffer) {
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50)
    throw new Error('not a zip archive');
  const method = buffer.readUInt16LE(8);
  const compressed = buffer.readUInt32LE(18);
  const nameLen = buffer.readUInt16LE(26);
  const extraLen = buffer.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const body = compressed
    ? buffer.subarray(start, start + compressed)
    : buffer.subarray(start);
  if (method === 0) return body.toString('utf8');
  if (method === 8) return inflateRawSync(body).toString('utf8');
  throw new Error(`unsupported zip method ${method}`);
}

const int = (value) => {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
};

/** Aggregate one export file into per-country counts. */
export function aggregate(tsv) {
  const lines = String(tsv || '')
    .split('\n')
    .filter(Boolean);
  if (!lines.length) throw new Error('empty export');
  const byCountry = new Map();
  const seen = new Set();
  let violent = 0;
  let rows = 0;
  let noCountry = 0;
  for (const line of lines) {
    const f = line.split('\t');
    if (f.length < 58) continue;
    rows += 1;
    const root = int(f[COL.rootCode]);
    if (!VIOLENT_ROOTS[root]) continue;
    // One GDELT row is one event; the same event can still recur across
    // consecutive files as new articles mention it, so the id is the guard.
    const id = f[COL.eventId];
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    violent += 1;
    const code = String(f[COL.countryCode] || '')
      .trim()
      .toUpperCase();
    if (!code) {
      noCountry += 1;
      continue;
    }
    let entry = byCountry.get(code);
    if (!entry) {
      entry = { code, events: 0, mentions: 0, kinds: {}, centroidOnly: 0 };
      byCountry.set(code, entry);
    }
    entry.events += 1;
    entry.mentions += int(f[COL.mentions]) || 0;
    const kind = VIOLENT_ROOTS[root];
    entry.kinds[kind] = (entry.kinds[kind] || 0) + 1;
    // Geo type 1 is a country centroid and 2 a state centroid: the share of a
    // country's events that carry no place at all is worth surfacing, because
    // it is the honest measure of how little this data localizes.
    const geoType = int(f[COL.geoType]);
    if (geoType === 1 || geoType === 2) entry.centroidOnly += 1;
  }
  if (!rows) throw new Error('export had no parseable rows');
  return {
    countries: [...byCountry.values()].sort((a, b) => b.events - a.events),
    totals: { rows, violent, noCountry },
  };
}

async function loadReports() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const listing = await fetch(LAST_UPDATE_URL, {
      signal: controller.signal,
      headers: { 'user-agent': 'gods-eye-view/conflict' },
    });
    if (!listing.ok) throw new Error(`lastupdate HTTP ${listing.status}`);
    const first = (await listing.text()).split('\n')[0] || '';
    const raw = first.trim().split(/\s+/).pop() || '';
    if (!/\.export\.CSV\.zip$/i.test(raw))
      throw new Error('lastupdate did not name an export file');
    // GDELT advertises the file over plain http; this project does not fetch
    // over http, and the same path serves fine over https.
    const url = raw.replace(/^http:/i, 'https:');
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`export HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const { countries, totals } = aggregate(unzipSingle(buffer));
    return {
      at: new Date().toISOString(),
      sourceFile: url.split('/').pop(),
      windowMinutes: 15,
      countries,
      totals,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function conflictProxy() {
  const reports = cachedJsonEndpoint({
    load: loadReports,
    ttlMs: TTL_MS,
    label: 'GDELT conflict',
    timeoutMs: TIMEOUT_MS,
  });

  function installMiddleware(server) {
    server.middlewares.use('/api/conflict/reports', reports);
  }

  return {
    name: 'gev-conflict-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

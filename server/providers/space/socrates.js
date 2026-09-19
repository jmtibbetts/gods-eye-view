import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { readResponseTextCapped } from '../common/http.js';

/**
 * Conjunctions — CelesTrak's SOCRATES, cut down to what is worth drawing.
 *
 * SOCRATES screens the whole public catalog against itself eight times a
 * day and publishes every pair that comes within five kilometres in the
 * next week: a hundred and fifty thousand rows, seventeen megabytes, most
 * of them Starlink passing Starlink at a comfortable distance. This proxy
 * reads that file on SOCRATES's own cadence and keeps the few dozen a
 * watcher would want: the highest collision probabilities, the closest
 * ranges, and anything involving a crewed station.
 *
 * Two things in the file are not conjunctions and are set aside. A pair
 * with no relative speed is a docked or formation-flying pair — Soyuz on
 * the ISS, listed at probability one — and the ISS appears under several
 * catalog numbers, one per module, so one Soyuz shows up four times.
 *
 * Placing a conjunction on the globe needs both objects' elements, and
 * debris is in no CelesTrak group the satellites layer loads, so they are
 * fetched here one object at a time (CelesTrak serves GP by catalog number,
 * one per request, a few seconds each) into a cache that outlives the
 * process. The list is served at once with whatever elements are on hand
 * and the rest filled in the background; the body says how many are still
 * pending, and the client asks again until none are.
 *
 * Routes:
 *   GET /api/space/conjunctions → { fetchedAt, pending, conjunctions: [...] }
 */

export const SOCRATES_URL = 'https://celestrak.org/SOCRATES/sort-minRange.csv';
export const gpUrl = (noradId) =>
  `https://celestrak.org/NORAD/elements/gp.php?CATNR=${encodeURIComponent(noradId)}&FORMAT=tle`;
export const CELESTRAK_USER_AGENT =
  'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** SOCRATES runs eight times a day; three hours matches its cadence. */
export const SOCRATES_TTL_MS = 3 * 3600_000;
/** Elements a day old place an object within a few kilometres — enough. */
export const GP_TTL_MS = 24 * 3600_000;
export const SOCRATES_MAX_BYTES = 48 * 1024 * 1024;
/** Below this relative speed a pair is docked or flying formation. */
export const CO_ORBITING_KMS = 0.05;
export const TOP_BY_PROBABILITY = 50;
export const TOP_BY_RANGE = 30;
export const MAX_CONJUNCTIONS = 100;
const GP_CONCURRENCY = 3;
const TIMEOUT_MS = 60_000;

/** The crewed stations, by the catalog numbers their pieces carry. */
export const STATION_IDS = Object.freeze({
  25544: 'ISS',
  25575: 'ISS',
  26400: 'ISS',
  26700: 'ISS',
  27556: 'ISS',
  28352: 'ISS',
  31138: 'ISS',
  48274: 'CSS',
});
const CREW_VEHICLE =
  /^(SOYUZ|PROGRESS|CREW DRAGON|DRAGON|CYGNUS|SHENZHOU|TIANZHOU|HTV|STARLINER|DREAM CHASER)/i;

const STATUS = Object.freeze({
  '+': 'active',
  '-': 'inactive',
  P: 'partially operational',
  B: 'backup',
  S: 'spare',
  X: 'extended mission',
  D: 'decayed',
  '?': 'unknown',
});

/** "STARLINK-5355 [+]" → { name: 'STARLINK-5355', status: 'active' }. */
export function splitName(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^(.*?)\s*\[(.)\]$/);
  if (!m) return { name: String(raw ?? '').trim(), status: 'unknown' };
  return { name: m[1], status: STATUS[m[2]] || 'unknown' };
}

/** A minimal RFC 4180 reader: quoted fields, commas inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "2026-09-24 02:08:18.268" → ISO, or null. */
function tcaToIso(value) {
  const t = Date.parse(
    `${String(value ?? '')
      .trim()
      .replace(' ', 'T')}Z`,
  );
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The SOCRATES file as records: one per row, statuses decoded, station
 * pieces folded onto the station's own number. No selection yet.
 */
export function parseSocrates(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const c = {
    id1: col('NORAD_CAT_ID_1'),
    name1: col('OBJECT_NAME_1'),
    dse1: col('DSE_1'),
    id2: col('NORAD_CAT_ID_2'),
    name2: col('OBJECT_NAME_2'),
    dse2: col('DSE_2'),
    tca: col('TCA'),
    range: col('TCA_RANGE'),
    speed: col('TCA_RELATIVE_SPEED'),
    prob: col('MAX_PROB'),
    dilution: col('DILUTION'),
  };
  if (Object.values(c).some((i) => i < 0))
    throw new Error('SOCRATES header is not the one documented');
  const out = [];
  for (const row of rows.slice(1)) {
    const id1 = num(row[c.id1]);
    const id2 = num(row[c.id2]);
    const tca = tcaToIso(row[c.tca]);
    if (id1 === null || id2 === null || !tca) continue;
    const a = splitName(row[c.name1]);
    const b = splitName(row[c.name2]);
    const station1 = STATION_IDS[id1] || null;
    const station2 = STATION_IDS[id2] || null;
    out.push({
      objects: [
        {
          noradId: station1 === 'ISS' ? 25544 : id1,
          name: station1 === 'ISS' ? 'ISS (ZARYA)' : a.name,
          status: a.status,
          station: station1,
          daysFromEpoch: num(row[c.dse1]),
        },
        {
          noradId: station2 === 'ISS' ? 25544 : id2,
          name: station2 === 'ISS' ? 'ISS (ZARYA)' : b.name,
          status: b.status,
          station: station2,
          daysFromEpoch: num(row[c.dse2]),
        },
      ],
      tca,
      rangeKm: num(row[c.range]),
      relativeSpeedKms: num(row[c.speed]),
      maxProbability: num(row[c.prob]),
      dilutionKm: num(row[c.dilution]),
    });
  }
  return out;
}

/** Docked and formation pairs, and a station against its own visitor at rest. */
export function isCoOrbiting(record) {
  return (
    record.relativeSpeedKms === null ||
    record.relativeSpeedKms < CO_ORBITING_KMS
  );
}

/** Whether a record involves a crewed station or a crew/cargo vehicle. */
export function isCrewed(record) {
  return record.objects.some(
    (o) => o.station || CREW_VEHICLE.test(o.name || ''),
  );
}

/** Stable id: the two catalog numbers, low first, and the TCA to the second. */
export function conjunctionId(record) {
  const [a, b] = record.objects.map((o) => o.noradId).sort((x, y) => x - y);
  return `${a}-${b}-${record.tca.slice(0, 19)}`;
}

/**
 * The few dozen worth drawing: future, not co-orbiting, deduplicated;
 * then the top by probability, the top by range, and every crewed one,
 * sorted by time of closest approach.
 * @param {Array<object>} records parseSocrates output.
 * @param {number} nowMs
 */
export function selectConjunctions(records, nowMs, limits = {}) {
  const {
    byProbability = TOP_BY_PROBABILITY,
    byRange = TOP_BY_RANGE,
    max = MAX_CONJUNCTIONS,
  } = limits;
  const seen = new Map();
  let coOrbiting = 0;
  let past = 0;
  const live = [];
  for (const r of records) {
    if (Date.parse(r.tca) < nowMs) {
      past++;
      continue;
    }
    if (isCoOrbiting(r)) {
      coOrbiting++;
      continue;
    }
    if (r.objects[0].noradId === r.objects[1].noradId) continue;
    live.push(r);
  }
  // A vehicle docked to a station shares the station's every close
  // approach: the same other object at the same second. Those are the
  // station's conjunction, once, not three more under the visitors' names.
  const stationApproach = new Set();
  for (const r of live)
    for (let i = 0; i < 2; i++)
      if (r.objects[i].station)
        stationApproach.add(
          `${r.objects[1 - i].noradId}-${r.tca.slice(0, 19)}`,
        );
  let docked = 0;
  for (const r of live) {
    const visitor = r.objects.findIndex(
      (o) => !o.station && CREW_VEHICLE.test(o.name || ''),
    );
    if (
      visitor >= 0 &&
      stationApproach.has(
        `${r.objects[1 - visitor].noradId}-${r.tca.slice(0, 19)}`,
      )
    ) {
      docked++;
      continue;
    }
    const id = conjunctionId(r);
    if (!seen.has(id)) seen.set(id, { id, ...r, crewed: isCrewed(r) });
  }
  const all = [...seen.values()];
  const chosen = new Map();
  const take = (list, why) => {
    for (const r of list) {
      if (!chosen.has(r.id)) chosen.set(r.id, { ...r, why: [why] });
      else chosen.get(r.id).why.push(why);
    }
  };
  take(
    [...all]
      .filter((r) => r.maxProbability !== null)
      .sort((a, b) => b.maxProbability - a.maxProbability)
      .slice(0, byProbability),
    'probability',
  );
  take(
    [...all]
      .filter((r) => r.rangeKm !== null)
      .sort((a, b) => a.rangeKm - b.rangeKm)
      .slice(0, byRange),
    'range',
  );
  take(
    all.filter((r) => r.crewed),
    'crewed',
  );
  const list = [...chosen.values()]
    .sort((a, b) => Date.parse(a.tca) - Date.parse(b.tca))
    .slice(0, max);
  list.total = all.length;
  list.coOrbiting = coOrbiting + docked;
  list.past = past;
  return list;
}

/** The two lines of a GP/TLE body for one object, or null. */
export function parseTleBody(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const l1 = lines.find((l) => /^1 \d{5}/.test(l));
  const l2 = lines.find((l) => /^2 \d{5}/.test(l));
  if (!l1 || !l2) return null;
  const name = lines[0] && !/^[12] \d{5}/.test(lines[0]) ? lines[0] : null;
  return { name, lines: [l1, l2] };
}

/**
 * The store of elements by catalog number, on disk, filled a few at a time.
 * @param {object} options
 * @param {string} options.file
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.ttlMs]
 * @param {number} [options.concurrency]
 */
export function createElementStore({
  file,
  fetchImpl = (...args) => fetch(...args),
  ttlMs = GP_TTL_MS,
  concurrency = GP_CONCURRENCY,
  now = () => Date.now(),
  log = (m) => console.warn(m),
} = {}) {
  /** @type {Map<number, {at:number, name:string|null, lines:string[]|null}>} */
  const store = new Map();
  let loaded = false;
  const queue = [];
  const queued = new Set();
  let running = 0;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      for (const [id, entry] of Object.entries(parsed || {}))
        if (Number.isFinite(entry?.at)) store.set(Number(id), entry);
    } catch {
      /* first run */
    }
  }

  async function save() {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(
        file,
        JSON.stringify(Object.fromEntries(store)),
        'utf8',
      );
    } catch {
      log('[socrates-proxy] element cache write failed');
    }
  }

  function fresh(id) {
    const entry = store.get(id);
    return entry && now() - entry.at < ttlMs ? entry : null;
  }

  async function fetchOne(id) {
    const response = await fetchImpl(gpUrl(id), {
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': CELESTRAK_USER_AGENT },
    });
    const text = await response.text();
    if (response.status === 404) return { at: now(), name: null, lines: null };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tle = parseTleBody(text);
    if (!tle) throw new Error('no TLE lines');
    return { at: now(), ...tle };
  }

  function pump() {
    while (running < concurrency && queue.length) {
      const id = queue.shift();
      running++;
      fetchOne(id)
        .then((entry) => {
          store.set(id, entry);
        })
        .catch(() => {
          // Leave it missing; the next request queues it again.
        })
        .finally(() => {
          running--;
          queued.delete(id);
          if (!queue.length && running === 0) void save();
          pump();
        });
    }
  }

  return {
    async prime() {
      await load();
    },
    /** Elements for an id if fresh; queues a fetch otherwise. */
    get(id) {
      const entry = fresh(id);
      if (entry) return entry;
      if (!queued.has(id)) {
        queued.add(id);
        queue.push(id);
        pump();
      }
      return null;
    },
    pending: () => queued.size,
    _store: store,
  };
}

/**
 * The route: SOCRATES on its cadence, elements from the store, the body
 * marked with how many are still on their way.
 */
export function createSocratesEndpoint({
  fetchImpl = (...args) => fetch(...args),
  cacheDir = path.join(process.cwd(), '.gev-cache'),
  ttlMs = SOCRATES_TTL_MS,
  now = () => Date.now(),
  elements = null,
  log = (m) => console.warn(m),
} = {}) {
  const listFile = path.join(cacheDir, 'socrates-v1.json');
  const store =
    elements ||
    createElementStore({
      file: path.join(cacheDir, 'socrates-elements-v1.json'),
      fetchImpl,
      now,
      log,
    });
  /** @type {?{at:number, list:Array<object>}} */
  let cache = null;
  let inflight = null;
  let diskRead = false;

  async function fromDisk() {
    if (diskRead) return;
    diskRead = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(listFile, 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.list))
        cache = parsed;
    } catch {
      /* first run */
    }
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const response = await fetchImpl(SOCRATES_URL, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'User-Agent': CELESTRAK_USER_AGENT },
        });
        const text = await readResponseTextCapped(response, SOCRATES_MAX_BYTES);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const list = selectConjunctions(parseSocrates(text), now());
        cache = {
          at: now(),
          list,
          total: list.total,
          coOrbiting: list.coOrbiting,
        };
        try {
          await fsp.mkdir(cacheDir, { recursive: true });
          await fsp.writeFile(listFile, JSON.stringify(cache), 'utf8');
        } catch {
          log('[socrates-proxy] list cache write failed');
        }
      } catch (error) {
        log(`[socrates-proxy] SOCRATES refresh failed: ${error?.message}`);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function body() {
    const nowMs = now();
    let pending = 0;
    const conjunctions = (cache?.list || [])
      .filter((c) => Date.parse(c.tca) >= nowMs)
      .map((c) => ({
        ...c,
        objects: c.objects.map((o) => {
          const entry = store.get(o.noradId);
          if (!entry) pending++;
          return { ...o, tle: entry?.lines || null };
        }),
      }));
    return JSON.stringify({
      fetchedAt: cache ? new Date(cache.at).toISOString() : null,
      total: cache?.total ?? 0,
      coOrbiting: cache?.coOrbiting ?? 0,
      pending,
      conjunctions,
    });
  }

  return async function handle(req, res) {
    res.setHeader('Content-Type', 'application/json');
    await Promise.all([fromDisk(), store.prime()]);
    if (!cache || now() - cache.at >= ttlMs) {
      if (cache) void refresh();
      else await refresh();
    }
    if (!cache) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'upstream_failed' }));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.end(body());
  };
}

export function socratesProxy() {
  const handle = createSocratesEndpoint();
  function installMiddleware(server) {
    server.middlewares.use('/api/space/conjunctions', handle);
  }
  return {
    name: 'gev-socrates-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

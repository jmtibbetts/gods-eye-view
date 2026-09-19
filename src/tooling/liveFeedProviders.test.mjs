import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cachedJsonEndpoint,
  listOf,
} from '../../server/providers/cachedEndpoint.js';
import { trimStation } from '../../server/providers/satnogs.js';
import {
  polygonParts,
  sequencer,
  trimDomestic,
  trimInternational,
} from '../../server/providers/aviation.js';
import { aggregate } from '../../server/providers/conflict.js';
import { hourPrefix } from '../../server/providers/lightning.js';

/** A connect-style response that records what the handler did with it. */
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(b) {
      this.body = b;
    },
  };
}

async function call(handler) {
  const res = fakeRes();
  await handler({}, res);
  return res;
}

// ---------------------------------------------------------------- cachedEndpoint

test('a fresh body is served and then reused within the TTL', async () => {
  let loads = 0;
  const handler = cachedJsonEndpoint({
    load: async () => ({ n: ++loads }),
    ttlMs: 60_000,
    label: 'test',
  });
  const a = await call(handler);
  const b = await call(handler);
  assert.equal(a.body, '{"n":1}');
  assert.equal(b.body, '{"n":1}');
  assert.equal(loads, 1, 'second call inside the TTL must not reload');
  assert.equal(a.headers['X-Gev-Stale'], undefined);
});

test('concurrent misses are coalesced into one upstream call', async () => {
  let loads = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const handler = cachedJsonEndpoint({
    load: async () => {
      loads += 1;
      await gate;
      return { ok: true };
    },
    ttlMs: 60_000,
    label: 'test',
  });
  const pending = [call(handler), call(handler), call(handler)];
  release();
  await Promise.all(pending);
  // Ten layers enabling at once must make one call, not ten.
  assert.equal(loads, 1);
});

test('a payload the shape function rejects is not cached', async () => {
  let loads = 0;
  const handler = cachedJsonEndpoint({
    load: async () => (++loads === 1 ? 'an error page' : ['ok']),
    ttlMs: 60_000,
    label: 'test',
    shape: listOf((x) => x),
  });
  const first = await call(handler);
  // An upstream error page parses as JSON perfectly well; it must not be
  // served confidently for the whole TTL.
  assert.equal(first.statusCode, 503);
  assert.match(first.body, /upstream_failed/);
  const second = await call(handler);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body, '["ok"]');
});

test('a failed refresh serves the last good body marked stale', async () => {
  let loads = 0;
  const handler = cachedJsonEndpoint({
    load: async () => {
      loads += 1;
      if (loads === 2) throw new Error('upstream down');
      return { n: loads };
    },
    ttlMs: 0, // every call is a miss
    label: 'test',
  });
  const first = await call(handler);
  assert.equal(first.body, '{"n":1}');
  const second = await call(handler);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body, '{"n":1}', 'slightly old beats nothing');
  assert.equal(second.headers['X-Gev-Stale'], '1');
});

test('with nothing at all to serve the endpoint answers 503 with an error body', async () => {
  const handler = cachedJsonEndpoint({
    load: async () => {
      throw new Error('down');
    },
    ttlMs: 60_000,
    label: 'test',
  });
  const res = await call(handler);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'upstream_failed' });
});

test('a disk cache survives a restart and is served stale while the upstream is down', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gev-cache-'));
  const file = join(dir, 'nested', 'cache.json');
  try {
    // Process one: succeeds and persists.
    const first = cachedJsonEndpoint({
      load: async () => ({ from: 'run-1' }),
      ttlMs: 60_000,
      label: 'test',
      diskCache: file,
    });
    await call(first);
    assert.equal(await readFile(file, 'utf8'), '{"from":"run-1"}');

    // Process two: upstream down from the start, nothing in memory.
    const second = cachedJsonEndpoint({
      load: async () => {
        throw new Error('down');
      },
      ttlMs: 60_000,
      label: 'test',
      diskCache: file,
    });
    const res = await call(second);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '{"from":"run-1"}');
    assert.equal(res.headers['X-Gev-Stale'], '1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt disk cache is ignored rather than served', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gev-cache-'));
  const file = join(dir, 'cache.json');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{"truncated": tru', 'utf8');
    const handler = cachedJsonEndpoint({
      load: async () => {
        throw new Error('down');
      },
      ttlMs: 60_000,
      label: 'test',
      diskCache: file,
    });
    const res = await call(handler);
    assert.equal(res.statusCode, 503);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an endpoint needs either a url or a load function', () => {
  assert.throws(
    () => cachedJsonEndpoint({ ttlMs: 1, label: 'x' }),
    /needs a url or a load function/,
  );
});

// --------------------------------------------------------------------- satnogs

test('station trimming keeps the dozen fields the globe reads and splits compound bands', () => {
  const out = trimStation({
    id: 7,
    name: 'Roof',
    lat: 1,
    lng: 2,
    altitude: 3,
    status: 'Online',
    is_connected: true,
    is_available: true,
    testing: false,
    observations: 10,
    future_observations: 2,
    success_rate: 80,
    last_seen: '2026-09-18T20:00:00Z',
    description: 'a long description that must not survive',
    image: 'x.png',
    owner: { name: 'someone' },
    antenna: [{ band: 'HF, VHF, UHF' }, { band: 'VHF' }, { band: '' }],
  });
  assert.deepEqual(out.bands, ['HF', 'VHF', 'UHF']);
  assert.equal(out.connected, true);
  assert.equal(out.lastSeen, '2026-09-18T20:00:00Z');
  assert.equal('description' in out, false);
  assert.equal('image' in out, false);
  assert.equal('owner' in out, false);
});

// -------------------------------------------------------------------- aviation

test('AREA and AREAS geometries both become a list of flat rings', () => {
  const pt = (lon, lat) => ({ lon, lat });
  const ring = [pt(0, 0), pt(1, 0), pt(1, 1)];
  assert.deepEqual(polygonParts(ring), [[0, 0, 1, 0, 1, 1]]);
  // `geom: 'AREAS'` gives a list of point LISTS; treating it as AREA rejected
  // a three-part thunderstorm SIGMET outright.
  assert.deepEqual(polygonParts([ring, ring]), [
    [0, 0, 1, 0, 1, 1],
    [0, 0, 1, 0, 1, 1],
  ]);
  assert.deepEqual(polygonParts([[pt(0, 0), pt(1, 999), pt(1, 1)]]), []);
  assert.deepEqual(polygonParts(null), []);
});

test('one series across several FIRs yields distinct area ids', () => {
  const next = sequencer();
  const base = {
    icaoId: 'FAOR',
    seriesId: 'B01',
    validTimeFrom: 1,
    hazard: 'TURB',
    coords: [],
  };
  const a = trimInternational(
    { ...base, firId: 'FACA' },
    next('FAOR:B01:1:FACA'),
  );
  const b = trimInternational(
    { ...base, firId: 'FAJA' },
    next('FAOR:B01:1:FAJA'),
  );
  const c = trimInternational(
    { ...base, firId: 'FAJA' },
    next('FAOR:B01:1:FAJA'),
  );
  assert.notEqual(a.id, b.id, 'Cape Town and Johannesburg must not collide');
  assert.notEqual(b.id, c.id, 'two areas in one FIR must not collide');
});

test('domestic and international rows normalize to one record shape', () => {
  const intl = trimInternational(
    {
      icaoId: 'X',
      seriesId: '1',
      validTimeFrom: 1,
      validTimeTo: 2,
      hazard: 'va',
      qualifier: 'MAYON',
      base: 0,
      top: 15000,
      dir: 90,
      spd: 10,
      chng: 'INTSF',
      firName: 'RPHI MANILA',
      coords: [],
    },
    1,
  );
  const dom = trimDomestic(
    {
      icaoId: 'KKCI',
      alphaChar: 'C',
      validTimeFrom: 1,
      validTimeTo: 2,
      hazard: 'CONVECTIVE',
      severity: 'SEV',
      altitudeLow1: null,
      altitudeHi1: 45000,
      movementDir: 110,
      movementSpd: 10,
      airSigmetType: 'SIGMET',
      coords: [],
    },
    1,
  );
  for (const key of [
    'id',
    'origin',
    'hazard',
    'from',
    'to',
    'parts',
    'region',
    'qualifier',
    'low',
    'high',
    'dir',
    'speed',
    'trend',
    'raw',
  ])
    assert.ok(key in intl && key in dom, `${key} missing from one shape`);
  assert.equal(intl.hazard, 'VA');
  assert.equal(intl.low, 0, 'a surface base is a real reading');
  assert.equal(dom.low, null, 'an absent base stays absent');
  assert.equal(dom.origin, 'domestic');
});

// -------------------------------------------------------------------- conflict

function gdeltRow({ id, root, country, geoType = '4', mentions = '1' }) {
  const f = new Array(61).fill('');
  f[0] = id;
  f[28] = root;
  f[31] = mentions;
  f[51] = geoType;
  f[53] = country;
  f[56] = '10';
  f[57] = '20';
  return f.join('\t');
}

test('aggregate counts violent roots per country and nothing else', () => {
  const tsv = [
    gdeltRow({ id: '1', root: '18', country: 'US' }),
    gdeltRow({ id: '2', root: '19', country: 'US' }),
    gdeltRow({ id: '3', root: '04', country: 'US' }), // consult — not violence
    gdeltRow({ id: '4', root: '20', country: 'IS' }),
  ].join('\n');
  const { countries, totals } = aggregate(tsv);
  assert.equal(totals.rows, 4);
  assert.equal(totals.violent, 3);
  assert.deepEqual(
    countries.map((c) => [c.code, c.events]),
    [
      ['US', 2],
      ['IS', 1],
    ],
  );
  assert.deepEqual(countries[0].kinds, { Assault: 1, Fight: 1 });
});

test('aggregate de-duplicates a repeated event id and counts centroid-only geocoding', () => {
  const tsv = [
    gdeltRow({ id: '9', root: '18', country: 'CI', geoType: '1' }),
    gdeltRow({ id: '9', root: '18', country: 'CI', geoType: '1' }),
    gdeltRow({ id: '10', root: '18', country: 'CI', geoType: '4' }),
  ].join('\n');
  const { countries } = aggregate(tsv);
  assert.equal(
    countries[0].events,
    2,
    'the same event id must not count twice',
  );
  // Geo type 1 (country) and 2 (state) carry no place inside the country.
  assert.equal(countries[0].centroidOnly, 1);
});

test('aggregate rejects an empty or unparseable export rather than reporting peace', () => {
  assert.throws(() => aggregate(''), /empty/);
  assert.throws(() => aggregate('not\ta\tgdelt\trow'), /no parseable rows/);
});

// ------------------------------------------------------------------- lightning

test('the GLM bucket prefix is laid out by UTC year, day-of-year and hour', () => {
  assert.equal(
    hourPrefix(new Date(Date.UTC(2026, 8, 18, 21, 5))),
    'GLM-L2-LCFA/2026/261/21/',
  );
  assert.equal(
    hourPrefix(new Date(Date.UTC(2026, 0, 1, 0, 0))),
    'GLM-L2-LCFA/2026/001/00/',
  );
  // Day-of-year must not be off by one at the year boundary.
  assert.equal(
    hourPrefix(new Date(Date.UTC(2026, 11, 31, 23, 59))),
    'GLM-L2-LCFA/2026/365/23/',
  );
});

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
import {
  createTfrLoader,
  mergeTfrs,
  notamIdOf,
  parseFaaDate,
  parseTfrText,
  tfrPageUrl,
  windowFromTitle,
} from '../../server/providers/tfr.js';
import {
  conjunctionId,
  createElementStore,
  createSocratesEndpoint,
  isCoOrbiting,
  parseCsv,
  parseSocrates,
  parseTleBody,
  selectConjunctions,
  splitName,
} from '../../server/providers/space/socrates.js';
import { aggregate } from '../../server/providers/conflict.js';
import { hourPrefix } from '../../server/providers/lightning.js';
import {
  MAX_METERS_PER_PIXEL,
  copernicusProxy,
  requestMetersPerPixel,
} from '../../server/providers/copernicus.js';

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

// ------------------------------------------------------------------------- tfr

const TFR_DETAIL_HTML = `<Table><TR><TD>NOTAM Number     :</TD><TD>FDC 6/2736</TD></TR>
<TR><TD>Issue Date     :</TD><TD>September 14, 2026 at 1210 UTC</TD></TR>
<TR><TD>Location     :</TD><TD>36 ZLC AIRSPACE BLACK ROCK, Nevada near LOVELOCK VORTAC (LLC)</TD></TR>
<TR><TD>Beginning Date and Time     :</TD><TD>September 20, 2026 at 1400 UTC</TD></TR>
<TR><TD>Ending Date and Time     :</TD><TD>September 21, 2026 at 0600 UTC</TD></TR>
<TR><TD>Reason for NOTAM     :</TD><TD>TO PROVIDE A SAFE ENVIRONMENT FOR ROCKET LAUNCH ACT</TD></TR>
<TR><TD>Type     :</TD><TD>Space Operations</TD></TR>
<TR><TD>Pilots May Contact     :</TD><TD>SALT LAKE (ZLC) ARTCC, 801-320-2560</TD></TR>
<TR><TD>Jump To: Affected Areas</TD></TR>
<TR><TD>Affected Area(s)</TD></TR><TR><TD>Airspace Definition: Center: On the LOVELOCK VORTAC (LLC) 319 degree radial at 50 nautical miles. Radius: 15 nautical miles</TD></TR>
<TR><TD>Altitude: From the surface up to Unlimited</TD></TR>
<TR><TD>Effective Date(s): From September 20, 2026 at 1400 UTC To September 21, 2026 at 0600 UTC</TD></TR>
<TR><TD>ENDSECTION1</TD></TR></Table>`;

const ring = (lon, lat) => [
  [lon - 0.2, lat - 0.2],
  [lon + 0.2, lat - 0.2],
  [lon + 0.2, lat + 0.2],
  [lon - 0.2, lat + 0.2],
  [lon - 0.2, lat - 0.2],
];
const feature = (key, gid, lon, lat, legal = 'SPACE OPERATIONS') => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [ring(lon, lat)] },
  properties: { GID: gid, NOTAM_KEY: key, LEGAL: legal, TITLE: 't' },
});

test('FAA dates, NOTAM keys and list titles parse the way the FAA writes them', () => {
  assert.equal(
    parseFaaDate('September 20, 2026 at 1400 UTC'),
    '2026-09-20T14:00:00.000Z',
  );
  assert.equal(parseFaaDate('September 20, 2026'), '2026-09-20T00:00:00.000Z');
  assert.equal(parseFaaDate('Septober 20, 2026'), null);
  assert.equal(parseFaaDate(null), null);
  assert.equal(notamIdOf('6/2736-1-FDC-F'), '6/2736');
  assert.equal(notamIdOf('6/2736'), '6/2736');
  assert.equal(notamIdOf('nope'), null);
  assert.equal(
    tfrPageUrl('6/2736'),
    'https://tfr.faa.gov/tfr3/?page=detail_6_2736',
  );
  const two = windowFromTitle(
    'Thurmont, MD, Saturday, September 19, 2026 through Sunday, September 20, 2026 Local',
  );
  assert.equal(two.begins, '2026-09-19T00:00:00.000Z');
  assert.equal(
    two.ends,
    '2026-09-20T23:59:00.000Z',
    'through the day means the end of it',
  );
  assert.equal(two.local, true);
  const one = windowFromTitle(
    'Virginia Beach, VA, Saturday, September 19, 2026 UTC',
  );
  assert.equal(one.begins, '2026-09-19T00:00:00.000Z');
  assert.equal(one.ends, '2026-09-19T23:59:00.000Z');
  assert.equal(one.local, false);
  assert.deepEqual(windowFromTitle('no dates here'), {
    begins: null,
    ends: null,
    local: false,
  });
});

test('a NOTAM detail page yields its times, altitude, reason and contact', () => {
  const detail = parseTfrText(TFR_DETAIL_HTML);
  assert.equal(detail.begins, '2026-09-20T14:00:00.000Z');
  assert.equal(detail.ends, '2026-09-21T06:00:00.000Z');
  assert.equal(detail.issued, '2026-09-14T12:10:00.000Z');
  assert.equal(detail.altitude, 'From the surface up to Unlimited');
  assert.equal(
    detail.reason,
    'TO PROVIDE A SAFE ENVIRONMENT FOR ROCKET LAUNCH ACT',
  );
  assert.match(detail.location, /^36 ZLC AIRSPACE BLACK ROCK/);
  assert.equal(detail.contact, 'SALT LAKE (ZLC) ARTCC, 801-320-2560');
  const empty = parseTfrText('<p>nothing useful</p>');
  assert.equal(empty.begins, null);
  assert.equal(empty.altitude, null);
});

test('list rows and shapes merge by NOTAM number; a shape without a row is dropped, a row without a shape is kept', () => {
  const list = [
    {
      notam_id: '6/2736',
      type: 'SPACE OPERATIONS',
      facility: 'ZLC',
      state: 'NV',
      description:
        '36 ZLC AIRSPACE BLACK ROCK, NV, Sunday, September 20, 2026 through Monday, September 21, 2026 UTC',
      mod_abs_time: '202609141210',
    },
    {
      notam_id: '6/3002',
      type: 'SECURITY',
      facility: 'ZDC',
      state: 'MD',
      description:
        'Thurmont, MD, Saturday, September 19, 2026 through Sunday, September 20, 2026 Local',
    },
    {
      notam_id: '6/4444',
      type: 'HAZARDS',
      description: 'Somewhere, September 19, 2026 UTC',
    },
    { notam_id: 'garbage' },
  ];
  const shapes = {
    features: [
      feature('6/2736-1-FDC-F', 233535, -119.0470123456, 40.87809199),
      feature('6/3002-1-FDC-F', 1, -77.4, 39.6, 'SECURITY'),
      feature('6/3002-2-FDC-F', 2, -77.5, 39.7, 'SECURITY'),
      feature('6/7777-1-FDC-F', 3, -100, 40, 'VIP'),
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: { NOTAM_KEY: '6/2736-9-FDC-F' },
      },
    ],
  };
  const details = new Map([['6/2736', parseTfrText(TFR_DETAIL_HTML)]]);
  const merged = mergeTfrs(list, shapes, details);
  assert.deepEqual(
    merged.map((t) => t.id),
    ['6/2736', '6/3002', '6/4444'],
  );
  const space = merged[0];
  assert.equal(space.timesExact, true);
  assert.equal(space.begins, '2026-09-20T14:00:00.000Z');
  assert.equal(space.modifiedAt, '2026-09-14T12:10:00.000Z');
  assert.equal(space.areas.length, 1, 'the point geometry is not an area');
  assert.equal(space.areas[0].ring[0], -119.24701, 'five decimals, a metre');
  assert.ok(Math.abs(space.centre.lat - 40.878) < 0.01);
  const sec = merged[1];
  assert.equal(sec.areas.length, 2, 'two areas under one NOTAM stay together');
  assert.equal(sec.timesExact, false);
  assert.equal(sec.localTime, true);
  assert.equal(sec.begins, '2026-09-19T00:00:00.000Z');
  assert.equal(sec.altitude, null);
  assert.equal(merged[2].areas.length, 0, 'listed, drawn nowhere');
  assert.equal(merged[2].centre, null);
});

test('the loader fetches the list and shapes, details for space operations only, and shrugs off a detail failure', async () => {
  const urls = [];
  const load = createTfrLoader({
    now: () => Date.parse('2026-09-19T00:00:00Z'),
    fetchImpl: async (url) => {
      urls.push(String(url));
      const u = String(url);
      const json = (body) => ({ ok: true, json: async () => body });
      if (u.includes('getTfrList'))
        return json([
          {
            notam_id: '6/2736',
            type: 'SPACE OPERATIONS',
            description: 'x, September 20, 2026 UTC',
          },
          {
            notam_id: '6/2735',
            type: 'SPACE OPERATIONS',
            description: 'y, September 19, 2026 UTC',
          },
          {
            notam_id: '6/3002',
            type: 'SECURITY',
            description: 'z, September 19, 2026 Local',
          },
        ]);
      if (u.includes('geoserver'))
        return json({ features: [feature('6/2736-1-FDC-F', 1, -119, 40.9)] });
      if (u.includes('getWebText?notamId=6%2F2736'))
        return json([{ notam_id: '6/2736', text: TFR_DETAIL_HTML }]);
      return { ok: false, status: 500, json: async () => ({}) };
    },
  });
  const body = await load();
  assert.equal(body.fetchedAt, '2026-09-19T00:00:00.000Z');
  assert.equal(body.tfrs.length, 3);
  assert.equal(
    urls.filter((u) => u.includes('getWebText')).length,
    2,
    'space ops only',
  );
  assert.equal(body.tfrs[0].timesExact, true);
  assert.equal(
    body.tfrs[1].timesExact,
    false,
    'its detail page failed; the title dates stand',
  );
  assert.equal(body.tfrs[2].timesExact, false);

  const down = createTfrLoader({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(() => down(), /HTTP 503/);
});

// ---------------------------------------------------------------------- socrates

const SOCRATES_CSV = [
  'NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION',
  '57139,STARLINK-5355 [+],5.662,1883,TITAN 3C TRANSTAGE DEB [-],6.080,2026-09-24 02:08:18.268,0.005,7.729,1.000E+00,0.000',
  '25544,ISS (ZARYA) [+],1.0,100057,SOYUZ-MS 29 [+],1.0,2026-09-21 04:31:10.666,0.006,0.000,1.000E+00,0.000',
  '25575,ISS (UNITY) [+],1.0,100057,SOYUZ-MS 29 [+],1.0,2026-09-21 04:31:10.666,0.006,0.000,1.000E+00,0.000',
  '25544,ISS (ZARYA) [+],1.0,44444,COSMOS 2251 DEB [-],1.0,2026-09-22 04:31:10.666,1.2,14.1,2.000E-05,0.100',
  '26400,ISS (ZVEZDA) [+],1.0,44444,COSMOS 2251 DEB [-],1.0,2026-09-22 04:31:10.666,1.2,14.1,2.000E-05,0.100',
  '48274,CSS (TIANHE) [+],1.0,55555,"FENGYUN 1C DEB, PIECE [-]",1.0,2026-09-21 00:00:00.000,3.0,10.0,1.000E-06,0.5',
  '11111,OLD SAT [P],1.0,22222,OLDER SAT [B],1.0,2026-09-18 00:00:00.000,0.1,9.0,5.000E-04,0.1',
  '33333,GEO A [+],1.0,33334,GEO B [+],1.0,2026-09-23 00:00:00.000,4.9,0.01,3.000E-03,0.1',
  '100060,CREW DRAGON 12 [+],1.0,44444,COSMOS 2251 DEB [-],1.0,2026-09-22 04:31:10.700,1.2,14.1,1.000E-06,0.100',
].join('\r\n');
const SOCRATES_NOW = Date.parse('2026-09-19T22:00:00Z');

test('SOCRATES rows parse with their statuses, and the station pieces fold onto the station', () => {
  assert.deepEqual(parseCsv('a,b\n"c, d",e\r\n'), [
    ['a', 'b'],
    ['c, d', 'e'],
  ]);
  assert.deepEqual(splitName('STARLINK-5355 [+]'), {
    name: 'STARLINK-5355',
    status: 'active',
  });
  assert.deepEqual(splitName('OLD SAT [P]'), {
    name: 'OLD SAT',
    status: 'partially operational',
  });
  assert.deepEqual(splitName('NO STATUS'), {
    name: 'NO STATUS',
    status: 'unknown',
  });
  const records = parseSocrates(SOCRATES_CSV);
  assert.equal(records.length, 9);
  assert.equal(records[0].tca, '2026-09-24T02:08:18.268Z');
  assert.equal(records[0].maxProbability, 1);
  assert.equal(records[0].objects[1].status, 'inactive');
  assert.equal(records[2].objects[0].noradId, 25544, 'UNITY is the ISS');
  assert.equal(records[2].objects[0].station, 'ISS');
  assert.equal(
    records[5].objects[1].name,
    'FENGYUN 1C DEB, PIECE',
    'a quoted comma survives',
  );
  assert.throws(() => parseSocrates('X,Y\n1,2'), /header/);
});

test('selection keeps the future, drops docked pairs, folds duplicates, and always keeps the crewed', () => {
  const records = parseSocrates(SOCRATES_CSV);
  assert.equal(isCoOrbiting(records[1]), true, 'Soyuz on the ISS at 0 km/s');
  assert.equal(
    isCoOrbiting(records[7]),
    true,
    'two GEO birds drifting at 10 m/s',
  );
  const chosen = selectConjunctions(records, SOCRATES_NOW);
  assert.deepEqual(
    chosen.map((c) => c.id),
    [
      '48274-55555-2026-09-21T00:00:00',
      '25544-44444-2026-09-22T04:31:10',
      '1883-57139-2026-09-24T02:08:18',
    ],
    'soonest first',
  );
  assert.equal(chosen.past, 1, 'OLD SAT was yesterday');
  assert.equal(
    chosen.coOrbiting,
    4,
    'two docked Soyuz rows, the GEO drift, and the Dragon riding the ISS',
  );
  assert.equal(chosen.total, 3);
  assert.ok(
    !chosen.some((c) => c.id.startsWith('44444-100060')),
    'a docked Dragon is the station’s conjunction, not its own',
  );
  const iss = chosen.find((c) => c.id.startsWith('25544'));
  assert.equal(iss.crewed, true);
  assert.ok(iss.why.includes('crewed'));
  assert.equal(
    conjunctionId(records[4]),
    conjunctionId(records[3]),
    'ZVEZDA and ZARYA are one conjunction',
  );
  // A tight budget still keeps every crewed one.
  const tight = selectConjunctions(records, SOCRATES_NOW, {
    byProbability: 1,
    byRange: 0,
  });
  assert.ok(tight.some((c) => c.id.startsWith('25544')));
  assert.ok(tight.some((c) => c.id.startsWith('48274')));
});

test('the element store fetches one object at a time, remembers misses, and reports what is pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gev-socrates-'));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('CATNR=404'))
      return { ok: false, status: 404, text: async () => 'No GP data found' };
    return {
      ok: true,
      status: 200,
      text: async () =>
        'TITAN 3C TRANSTAGE DEB  \r\n1 01883U 65082EY  26261.99072198  .00004755  00000+0  18475-3 0  9991\r\n2 01883  32.0917 144.2856 0013039 296.3981  63.5343 15.24572891279622\r\n',
    };
  };
  const store = createElementStore({
    file: join(dir, 'el.json'),
    fetchImpl,
    concurrency: 1,
    log: () => {},
  });
  await store.prime();
  assert.equal(store.get(1883), null, 'not yet: queued');
  assert.equal(store.get(404), null);
  assert.equal(store.pending(), 2);
  for (let i = 0; i < 20 && store.pending(); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.pending(), 0);
  assert.equal(calls.length, 2, 'one request per object, once');
  assert.deepEqual(
    store.get(1883).lines.map((l) => l.slice(0, 7)),
    ['1 01883', '2 01883'],
  );
  assert.equal(store.get(1883).name, 'TITAN 3C TRANSTAGE DEB');
  assert.deepEqual(
    store.get(404).lines,
    null,
    'a 404 is remembered as no elements, not retried every call',
  );
  assert.equal(parseTleBody('nothing here'), null);
  await new Promise((r) => setTimeout(r, 20));
  const persisted = JSON.parse(await readFile(join(dir, 'el.json'), 'utf8'));
  assert.ok(persisted['1883'].lines);
  await rm(dir, { recursive: true, force: true });
});

test('the endpoint serves the cut list at once with the elements it has, and says how many are pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gev-socrates-'));
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('SOCRATES'))
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: null,
        text: async () => SOCRATES_CSV,
      };
    return {
      ok: true,
      status: 200,
      text: async () =>
        `X\n1 ${u.match(/CATNR=(\d+)/)[1].padStart(5, '0')}U 65082EY  26261.99072198  .00004755  00000+0  18475-3 0  9991\n2 ${u.match(/CATNR=(\d+)/)[1].padStart(5, '0')}  32.0917 144.2856 0013039 296.3981  63.5343 15.24572891279622\n`,
    };
  };
  const elements = createElementStore({
    file: join(dir, 'el.json'),
    fetchImpl,
    concurrency: 2,
    log: () => {},
  });
  const handle = createSocratesEndpoint({
    fetchImpl,
    cacheDir: dir,
    now: () => SOCRATES_NOW,
    elements,
    log: () => {},
  });
  const first = await call(handle);
  const body = JSON.parse(first.body);
  assert.equal(body.conjunctions.length, 3);
  assert.equal(body.total, 3);
  assert.equal(body.coOrbiting, 4);
  assert.ok(body.pending > 0, 'elements are still on their way');
  assert.equal(body.conjunctions[0].objects[0].tle, null);
  for (let i = 0; i < 40 && elements.pending(); i++)
    await new Promise((r) => setTimeout(r, 5));
  const second = JSON.parse((await call(handle)).body);
  assert.equal(second.pending, 0);
  assert.ok(
    second.conjunctions.every((c) =>
      c.objects.every((o) => Array.isArray(o.tle)),
    ),
  );
  await new Promise((r) => setTimeout(r, 20));
  await rm(dir, { recursive: true, force: true });
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

// ---------------------------------------------------------------- copernicus

test('a GetMap pixel size is read off the bounding box on its larger axis', () => {
  // A level-5 geographic tile: 5.625° over 256 px, the 2445.98 m/px Sentinel
  // Hub quotes when it refuses. Axis order and parameter case do not matter.
  const level5 = new URLSearchParams({
    bbox: '0,0,5.625,5.625',
    width: '256',
    height: '256',
  });
  assert.ok(Math.abs(requestMetersPerPixel(level5) - 2445.98) < 0.01);
  const level9 = new URLSearchParams({
    BBOX: '40,-100,40.3515625,-99.6484375',
    WIDTH: '256',
    HEIGHT: '256',
  });
  assert.ok(Math.abs(requestMetersPerPixel(level9) - 152.87) < 0.01);
  assert.ok(requestMetersPerPixel(level9) < MAX_METERS_PER_PIXEL);
  assert.equal(
    requestMetersPerPixel(new URLSearchParams({ bbox: '0,0,1' })),
    null,
  );
  assert.equal(
    requestMetersPerPixel(
      new URLSearchParams({ bbox: '0,0,1,1', width: '0', height: '256' }),
    ),
    null,
  );
});

test('the Copernicus proxy answers a too-coarse tile itself, transparent, before any upstream call', async () => {
  // Sentinel Hub would answer such a request with a picture of the error
  // message, and the globe painted that as data. The proxy now refuses it
  // locally with a transparent tile — and decides BEFORE the token exchange,
  // so no credential round-trip is spent on a tile that cannot exist.
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  process.env.COPERNICUS_INSTANCE_ID = 'test-instance';
  process.env.COPERNICUS_CLIENT_ID = 'id';
  process.env.COPERNICUS_CLIENT_SECRET = 'secret';
  globalThis.fetch = async () => {
    upstreamCalls++;
    throw new Error('no network in this test');
  };
  try {
    const handlers = new Map();
    copernicusProxy().configureServer({
      middlewares: { use: (path, handler) => handlers.set(path, handler) },
    });
    const wms = handlers.get('/api/copernicus/wms');
    const res = fakeRes();
    await wms(
      {
        url: '/?service=WMS&request=GetMap&layers=TRUE_COLOR&bbox=0,0,5.625,5.625&width=256&height=256&format=image/png',
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.equal(res.headers['X-GEV-Skipped'], 'pixel-size-over-limit');
    assert.ok(Buffer.isBuffer(res.body) && res.body.length > 0);
    // PNG signature, and nothing was fetched — not even a token.
    assert.equal(res.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(upstreamCalls, 0, 'a refused tile costs no upstream call');

    // A request within the limit proceeds to the token exchange as before.
    const fine = fakeRes();
    await wms(
      {
        url: '/?service=WMS&request=GetMap&layers=TRUE_COLOR&bbox=40,-100,40.3515625,-99.6484375&width=256&height=256',
      },
      fine,
    );
    assert.equal(
      upstreamCalls,
      1,
      'an in-range tile reaches the token exchange',
    );
    assert.notEqual(fine.headers['X-GEV-Skipped'], 'pixel-size-over-limit');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of [
      'COPERNICUS_INSTANCE_ID',
      'COPERNICUS_CLIENT_ID',
      'COPERNICUS_CLIENT_SECRET',
    ]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TFR_FILTER,
  TFR_CLASSES,
  TFR_FILTERS,
  tfrClassFor,
  tfrCurrent,
  tfrFilterFor,
} from './policy.js';
import {
  areaId,
  parseTfrs,
  summarizeTfrs,
  tfrPhase,
  windowText,
} from './records.js';
import { createTfrSource } from './source.js';
import { createTfrLayer, tfrLabelText } from './index.js';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const ALL = tfrFilterFor('all');

const BOX = [-119.4, 40.6, -118.7, 40.6, -118.7, 41.1, -119.4, 41.1, -119.4, 40.6];

function tfr(over = {}) {
  return {
    id: '6/2736',
    type: 'SPACE OPERATIONS',
    facility: 'ZLC',
    state: 'NV',
    title:
      '36 ZLC AIRSPACE BLACK ROCK, NV, Sunday, September 20, 2026 through Monday, September 21, 2026 UTC',
    begins: '2026-09-20T14:00:00.000Z',
    ends: '2026-09-21T06:00:00.000Z',
    timesExact: true,
    localTime: false,
    altitude: 'From the surface up to Unlimited',
    reason: 'TO PROVIDE A SAFE ENVIRONMENT FOR ROCKET LAUNCH ACT',
    location: '36 ZLC AIRSPACE BLACK ROCK, Nevada near LOVELOCK VORTAC (LLC)',
    contact: 'SALT LAKE (ZLC) ARTCC, 801-320-2560',
    areas: [{ gid: 233535, ring: BOX, centre: { lat: 40.85, lon: -119.05 } }],
    centre: { lat: 40.85, lon: -119.05 },
    pageUrl: 'https://tfr.faa.gov/tfr3/?page=detail_6_2736',
    ...over,
  };
}

test('every FAA type maps to a class, and an unknown one is drawn, not dropped', () => {
  assert.equal(tfrClassFor('SPACE OPERATIONS').key, 'space');
  assert.equal(tfrClassFor('space operations').key, 'space');
  assert.equal(tfrClassFor('HAZARDS').key, 'hazard');
  assert.equal(tfrClassFor('SECURITY').key, 'security');
  assert.equal(tfrClassFor('SPECIAL').key, 'security');
  assert.equal(tfrClassFor('VIP').key, 'vip');
  assert.equal(tfrClassFor('AIR SHOWS/SPORTS').key, 'event');
  assert.equal(tfrClassFor('UAS PUBLIC GATHERING').key, 'event');
  const odd = tfrClassFor('NEWTHING');
  assert.equal(odd.key, 'other');
  assert.ok(odd.name.includes('NEWTHING'));
  // The launch closure is drawn on top of everything it overlaps.
  assert.equal(
    Math.max(...TFR_CLASSES.map((c) => c.rank)),
    tfrClassFor('SPACE OPERATIONS').rank,
  );
  assert.equal(tfrFilterFor('nonsense').key, DEFAULT_TFR_FILTER);
  assert.equal(TFR_FILTERS[0].key, 'all');
});

test('the body fans out to one polygon per area, filtered, and the over ones are counted', () => {
  const four = tfr({
    id: '6/3002',
    type: 'SECURITY',
    areas: [1, 2, 3, 4].map((gid) => ({
      gid,
      ring: BOX,
      centre: { lat: 40.85, lon: -119.05 },
    })),
  });
  const gone = tfr({
    id: '6/1000',
    type: 'VIP',
    ends: '2026-09-01T00:00:00.000Z',
  });
  const shapeless = tfr({ id: '6/2000', type: 'HAZARDS', areas: [] });
  const payload = { fetchedAt: 'x', tfrs: [tfr(), four, gone, shapeless] };

  const all = parseTfrs(payload, ALL, NOW);
  assert.equal(all.length, 5, 'one space box plus four security boxes');
  assert.equal(all.over, 1);
  assert.equal(all.noShape, 1);
  assert.equal(all.total, 3, 'the NOTAMs still current, drawn or not');
  assert.equal(all[all.length - 1].classKey, 'space', 'drawn last: on top');
  assert.equal(new Set(all.map((a) => a.id)).size, 5);
  assert.equal(all.find((a) => a.notamId === '6/3002').parts, 4);
  assert.equal(areaId('6/2736', 233535), '6/2736#233535');

  const space = parseTfrs(payload, tfrFilterFor('space'), NOW);
  assert.equal(space.length, 1);
  const summary = summarizeTfrs(all, ALL);
  assert.equal(summary.notams, 2);
  assert.equal(summary.polygons, 5);
  assert.equal(summary.worst, 'Space operations');
  assert.deepEqual(
    summary.breakdown.map((b) => `${b.name}:${b.count}`).sort(),
    ['Security:1', 'Space operations:1'],
  );
  assert.equal(tfrCurrent({ ends: null }, NOW), true);
});

test('the window reads to the minute when the NOTAM was fetched, and as days when not', () => {
  assert.equal(windowText(tfr()), 'Sep 20 14:00Z → Sep 21 06:00Z');
  assert.equal(
    windowText(
      tfr({
        timesExact: false,
        localTime: true,
        begins: '2026-09-19T00:00:00.000Z',
        ends: '2026-09-20T23:59:00.000Z',
      }),
    ),
    'Sep 19 – Sep 20 (local days — exact times on the NOTAM)',
  );
  assert.equal(
    windowText(
      tfr({
        timesExact: false,
        begins: '2026-09-19T00:00:00.000Z',
        ends: '2026-09-19T23:59:00.000Z',
      }),
    ),
    'Sep 19 (UTC days — exact times on the NOTAM)',
  );
  assert.equal(windowText({ begins: null, ends: null }), null);
  assert.equal(tfrPhase(tfr(), NOW), 'ahead');
  assert.equal(tfrPhase(tfr(), Date.parse('2026-09-20T15:00:00Z')), 'active');
  assert.equal(tfrPhase(tfr(), Date.parse('2026-09-22T00:00:00Z')), 'over');
});

test('the card names the NOTAM, the window, the altitude and the rule', () => {
  const [area] = parseTfrs({ tfrs: [tfr()] }, ALL, NOW);
  const text = tfrLabelText(area, NOW);
  assert.match(text, /^FDC 6\/2736 · Space operations/);
  assert.match(text, /Opens Sep 20 14:00Z → Sep 21 06:00Z/);
  assert.match(text, /surface up to Unlimited/);
  assert.match(text, /91\.143/);
  assert.match(text, /Pilots contact SALT LAKE/);
});

test('the source reads the proxy and refuses an error body or a non-list', async () => {
  let asked = null;
  const ok = createTfrSource({
    fetchImpl: async (url) => {
      asked = url;
      return { ok: true, json: async () => ({ fetchedAt: 'x', tfrs: [] }) };
    },
  });
  const body = await ok.fetchTfrs();
  assert.ok(asked.startsWith('/api/aviation/tfrs'));
  assert.deepEqual(body.tfrs, []);
  const down = createTfrSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: 'upstream_failed' }),
    }),
  });
  await assert.rejects(() => down.fetchTfrs(), /unavailable/);
  const odd = createTfrSource({
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  await assert.rejects(() => odd.fetchTfrs(), /not a list/);
});

test('the layer draws, re-cuts on a filter change without refetching, and finds closures near a pad', async () => {
  let fetches = 0;
  const source = {
    fetchTfrs: async () => {
      fetches++;
      return {
        fetchedAt: 'x',
        tfrs: [
          tfr(),
          tfr({ id: '6/9999', type: 'VIP', centre: { lat: 30, lon: -80 } }),
        ],
      };
    },
  };
  const viewer = {
    dataSources: {
      added: [],
      add(ds) {
        this.added.push(ds);
      },
      remove() {},
    },
    scene: { requestRender() {} },
  };
  const layer = createTfrLayer({ source, now: () => NOW });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  assert.equal(fetches, 1);
  const ds = viewer.dataSources.added[0];
  assert.equal(ds.entities.values.length, 2);
  assert.equal(layer.getStats().count, 2);
  assert.match(layer.getStats().coverage, /2 NOTAMs · worst Space operations/);
  assert.equal(
    layer.getRowControls().chips.find((c) => c.active).id,
    'all',
  );

  assert.equal(await layer.setParams({ type: 'space' }), true);
  assert.equal(fetches, 1, 'a filter change is a re-cut, not a refetch');
  assert.equal(ds.entities.values.length, 1);
  assert.equal(layer.getAnalystRecords().length, 1);
  assert.equal(layer.getAnalystRecords()[0].name, 'FDC 6/2736');

  // Black Rock is ~11 km from the closure's centre; the Cape is not.
  const near = layer.findTfrsNear({
    lat: 40.78,
    lon: -119.05,
    maxKm: 250,
    type: 'SPACE OPERATIONS',
  });
  assert.equal(near.length, 1);
  assert.equal(near[0].id, '6/2736');
  assert.ok(near[0].distanceKm < 20, `${near[0].distanceKm} km`);
  assert.equal(near[0].phase, 'ahead');
  assert.equal(near[0].window, 'Sep 20 14:00Z → Sep 21 06:00Z');
  assert.equal(
    layer.findTfrsNear({ lat: 28.6, lon: -80.6, type: 'SPACE OPERATIONS' })
      .length,
    0,
  );
  layer.disable();
  assert.equal(ds.entities.values.length, 0);
  assert.equal(await layer.ensureTfrs(), await layer.ensureTfrs(), 'held');
  assert.equal(fetches, 1);
  layer.destroy();
});

test('a failed load keeps its error through the disable the manager triggers', async () => {
  const layer = createTfrLayer({
    source: {
      fetchTfrs: async () => {
        throw new Error('upstream exploded');
      },
    },
  });
  layer.enable();
  await layer.update();
  assert.match(layer.getStats().error ?? '', /upstream exploded/);
  layer.disable();
  assert.match(layer.getStats().error ?? '', /upstream exploded/);
  assert.match(layer.getStats().coverage, /unavailable/);
  assert.throws(() => createTfrLayer({}), /requires a TFR source/);
});

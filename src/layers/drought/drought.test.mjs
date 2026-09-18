import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRODUCT,
  DROUGHT_CLASSES,
  DROUGHT_PRODUCTS,
  GENERALIZE_DEGREES,
  MIN_PART_KM2,
  OUTLOOK_CLASSES,
  droughtClassFor,
  droughtQueryUrl,
  outlookClassFor,
  productFor,
  ringAreaKm2,
} from './policy.js';
import { isoDay, parseDrought, summarizeDrought } from './records.js';
import { createDroughtSource } from './source.js';
import { droughtLabelText } from './index.js';

const MONITOR = productFor('current');
const MONTHLY = productFor('monthly');

/** A square of `side` degrees at the given corner, as a GeoJSON ring. */
function square(lon, lat, side) {
  return [
    [lon, lat],
    [lon + side, lat],
    [lon + side, lat + side],
    [lon, lat + side],
    [lon, lat],
  ];
}

/** A square comfortably above the minimum-part threshold. */
const BIG = square(-100, 35, 1);

function feature(props, rings = [BIG]) {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: rings },
    properties: props,
  };
}

test('the monitor and the outlooks ask for their own columns', () => {
  const monitor = new URL(droughtQueryUrl(MONITOR));
  assert.equal(monitor.searchParams.get('outFields'), 'dm,ddate');
  assert.ok(monitor.pathname.includes('US_Drought_Intensity_v1'));

  const monthly = new URL(droughtQueryUrl(MONTHLY));
  assert.equal(
    monthly.searchParams.get('outFields'),
    'outlook,fcst_date,target',
  );
  assert.ok(monthly.pathname.includes('cpc_drought_outlk'));
  assert.ok(monthly.pathname.includes('/MapServer/1/query'));
  assert.ok(
    droughtQueryUrl(productFor('seasonal')).includes('/MapServer/4/query'),
  );
});

test('every query asks the server to generalize', () => {
  // Full-resolution Drought Monitor polygons are ~8.9 MB of GeoJSON. Losing
  // this parameter would not fail any test except this one; it would just make
  // the layer take fifteen times as long to appear.
  for (const product of DROUGHT_PRODUCTS) {
    const url = new URL(droughtQueryUrl(product));
    assert.equal(
      url.searchParams.get('maxAllowableOffset'),
      String(GENERALIZE_DEGREES),
    );
    assert.equal(url.searchParams.get('outSR'), '4326');
  }
});

test('an unknown product falls back to the default rather than throwing', () => {
  assert.equal(productFor('nonsense').key, DEFAULT_PRODUCT);
  assert.equal(productFor(undefined).key, DEFAULT_PRODUCT);
});

test('drought classes carry the service severity order', () => {
  const ranks = DROUGHT_CLASSES.map((c) => c.rank);
  assert.deepEqual(
    ranks,
    [...ranks].sort((a, b) => a - b),
  );
  assert.equal(droughtClassFor(4).name, 'D4 Exceptional Drought');
  assert.equal(droughtClassFor('2').name, 'D2 Severe Drought');
  assert.equal(droughtClassFor(9), null);
});

test('a missing drought code is not read as D0', () => {
  // `Number('')`, `Number(null)` and `Number(false)` are all 0, which is a
  // valid class. Without an explicit guard a feature that arrived with no
  // class at all would be drawn as D0 Abnormally Dry — a drought reading
  // invented from missing data.
  for (const missing of [null, undefined, '', '   ', false, true, NaN, 'abc'])
    assert.equal(
      droughtClassFor(missing),
      null,
      `${String(missing)} became a class`,
    );
  // A real zero still resolves.
  assert.equal(droughtClassFor(0).key, 'd0');
  assert.equal(droughtClassFor('0').key, 'd0');

  const bands = parseDrought(
    { features: [feature({ dm: '', ddate: 0 }), feature({ ddate: 0 })] },
    MONITOR,
  );
  assert.equal(bands.length, 0);
});

test('CPC No_Drought is dropped rather than painted', () => {
  // CPC publishes it with alpha 0 — the service saying it is not drawn. It
  // arrives on every outlook and covers most of the country, so painting it
  // would blanket the map in a class meaning "nothing to report".
  assert.equal(outlookClassFor('No_Drought'), null);
  assert.equal(outlookClassFor('Persistence').name, 'Drought persists');
  assert.equal(outlookClassFor('  development  ').rank, 4);
  assert.equal(outlookClassFor(''), null);

  const bands = parseDrought(
    {
      features: [
        feature({ outlook: 'No_Drought', target: 'Sep 2026' }),
        feature({ outlook: 'Persistence', target: 'Sep 2026' }, [
          square(-90, 35, 1),
        ]),
      ],
    },
    MONTHLY,
  );
  assert.equal(bands.length, 1);
  assert.equal(bands[0].classKey, 'Persistence');
});

test('bands sort least severe first so the worse class draws on top', () => {
  // The published bands overlap across roughly a tenth of their area — measured
  // at full resolution, so it is the data and not a generalization artifact.
  // Where two cover the same ground the worse one must draw last.
  const bands = parseDrought(
    {
      features: [
        feature({ dm: 4, ddate: 0 }),
        feature({ dm: 0, ddate: 0 }, [square(-90, 35, 1)]),
        feature({ dm: 2, ddate: 0 }, [square(-80, 35, 1)]),
      ],
    },
    MONITOR,
  );
  assert.deepEqual(
    bands.map((b) => b.classKey),
    ['d0', 'd2', 'd4'],
  );
});

test('holes are kept so a class is not painted over ground it does not cover', () => {
  const withHole = [square(-100, 35, 4), square(-99, 36, 1)];
  const [band] = parseDrought(
    { features: [feature({ dm: 1, ddate: 0 }, withHole)] },
    MONITOR,
  );
  assert.equal(band.holes.length, 1);
  assert.equal(band.holes[0].length, 10);
});

test('a part below the geometry resolution is dropped and counted', () => {
  // MIN_PART_KM2 is derived from the generalization tolerance, so a part under
  // it is smaller than the precision of the geometry the service returned.
  const tiny = square(-100, 35, 0.001);
  const bands = parseDrought(
    {
      features: [
        feature({ dm: 1, ddate: 0 }, [tiny]),
        feature({ dm: 1, ddate: 0 }, [BIG]),
      ],
    },
    MONITOR,
  );
  assert.equal(bands.length, 1);
  assert.equal(bands.droppedParts, 1);
  assert.equal(summarizeDrought(bands, MONITOR).droppedParts, 1);
});

test('the dropped-part threshold tracks the generalization tolerance', () => {
  // If one is tuned without the other, the layer starts either dropping
  // visible bands or drawing slivers finer than the data behind them.
  const expected = (GENERALIZE_DEGREES * 111.32) ** 2;
  assert.ok(Math.abs(MIN_PART_KM2 - expected) < 1e-9);
});

test('ring area is right to within a few percent', () => {
  // One degree square at the equator is about 12,391 km2.
  const equator = ringAreaKm2([0, 0, 1, 0, 1, 1, 0, 1, 0, 0]);
  assert.ok(Math.abs(equator - 12391) / 12391 < 0.02, `got ${equator}`);
  // The same square at 60N covers about half that.
  const high = ringAreaKm2([0, 60, 1, 60, 1, 61, 0, 61, 0, 60]);
  assert.ok(high < equator * 0.55 && high > equator * 0.45, `got ${high}`);
  assert.equal(ringAreaKm2([0, 0]), 0);
  assert.equal(ringAreaKm2(null), 0);
});

test('a ring with an unusable vertex is rejected whole', () => {
  // A band drawn with a missing corner puts a boundary where the service did not.
  const bands = parseDrought(
    {
      features: [
        feature({ dm: 1, ddate: 0 }, [
          [
            [-100, 35],
            [-99, 999],
            [-99, 36],
            [-100, 35],
          ],
        ]),
      ],
    },
    MONITOR,
  );
  assert.equal(bands.length, 0);
});

test('an ArcGIS epoch date becomes a plain day', () => {
  assert.equal(isoDay(Date.UTC(2026, 8, 15)), '2026-09-15');
  assert.equal(isoDay(''), '');
  assert.equal(isoDay(null), '');
  assert.equal(isoDay('Sep 2026'), 'Sep 2026');
});

test('the summary names the worst class and the date it describes', () => {
  const bands = parseDrought(
    {
      features: [
        feature({ dm: 0, ddate: Date.UTC(2026, 8, 15) }),
        feature({ dm: 3, ddate: Date.UTC(2026, 8, 15) }, [square(-90, 35, 1)]),
      ],
    },
    MONITOR,
  );
  const summary = summarizeDrought(bands, MONITOR);
  assert.equal(summary.bands, 2);
  assert.equal(summary.worst, 'D3 Extreme Drought');
  assert.equal(summary.valid, '2026-09-15');
  assert.deepEqual(summary.breakdown, [
    { name: 'D0 Abnormally Dry', count: 1 },
    { name: 'D3 Extreme Drought', count: 1 },
  ]);
});

test('an empty result summarizes without inventing a worst case', () => {
  const summary = summarizeDrought([], MONITOR);
  assert.equal(summary.bands, 0);
  assert.equal(summary.worst, null);
  assert.equal(summary.worstRank, 0);
});

test('the monitor card says it is weekly and the outlook card says it is a forecast', () => {
  const [monitor] = parseDrought(
    { features: [feature({ dm: 2, ddate: Date.UTC(2026, 8, 15) })] },
    MONITOR,
  );
  const monitorCard = droughtLabelText(monitor);
  assert.ok(monitorCard.includes('2026-09-15'));
  assert.ok(monitorCard.includes('released weekly'));
  assert.ok(!monitorCard.includes('forecast'));

  const [outlook] = parseDrought(
    {
      features: [
        feature({
          outlook: 'Development',
          target: 'Sep 2026',
          fcst_date: '08/31/2026',
        }),
      ],
    },
    MONTHLY,
  );
  const outlookCard = droughtLabelText(outlook);
  assert.ok(outlookCard.includes('Valid through Sep 2026'));
  assert.ok(outlookCard.includes('Issued 08/31/2026'));
  assert.ok(outlookCard.includes('not current conditions'));
});

test('outlook classes rank by how much worse the outlook is', () => {
  const ranks = OUTLOOK_CLASSES.map((c) => c.rank);
  assert.deepEqual(
    ranks,
    [...ranks].sort((a, b) => a - b),
  );
  assert.ok(
    outlookClassFor('Development').rank > outlookClassFor('Removal').rank,
  );
});

test('an ArcGIS error inside a 200 is an error, not an absence of drought', () => {
  const source = createDroughtSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: { message: 'Failed to execute query.' } }),
    }),
  });
  return assert.rejects(
    () => source.fetchDrought(MONITOR),
    /Failed to execute query/,
  );
});

test('an HTTP failure surfaces rather than emptying the map', () => {
  const source = createDroughtSource({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  return assert.rejects(() => source.fetchDrought(MONITOR), /500/);
});

test('a caller abort is honoured', async () => {
  const controller = new AbortController();
  const source = createDroughtSource({
    fetchImpl: (url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  const pending = source.fetchDrought(MONITOR, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /aborted/);
});

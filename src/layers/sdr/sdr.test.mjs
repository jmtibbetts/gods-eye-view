import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  normalizeSdrDirectory,
  sdrReceiverUrl,
  sdrRegionWithoutDirection,
  sdrStatedPlace,
} from './records.js';
import {
  createSdrSelectedOverlayEntry,
  mapSdrAnalystRecord,
  sdrBandText,
  sdrCoversFrequency,
  sdrTunedUrl,
} from './model.js';
import { auditReceiver, FAR_KM } from '../../../scripts/check-sdr-places.mjs';
import { createBundledSdrSource } from './source.js';
import { createSdrLayer } from './index.js';

test('receiver URLs must be public http(s) pages', () => {
  assert.equal(
    sdrReceiverUrl('http://rx.example.org:8073/'),
    'http://rx.example.org:8073/',
  );
  assert.equal(sdrReceiverUrl('https://user:pw@rx.example.org/'), null);
  assert.equal(sdrReceiverUrl('http://192.168.1.5:8073/'), null);
  assert.equal(sdrReceiverUrl('ftp://rx.example.org/'), null);
  assert.equal(sdrReceiverUrl('not a url'), null);
});

test('directory normalization drops bad rows and dedupes ids', () => {
  const rows = normalizeSdrDirectory({
    receivers: [
      {
        id: 'a',
        name: 'Kiwi A',
        url: 'http://a.example:8073/',
        lat: 50,
        lon: 6,
        type: 'kiwisdr',
        bands: [0, 30e6],
      },
      {
        id: 'a',
        name: 'dup',
        url: 'http://a.example:8073/',
        lat: 50,
        lon: 6,
        type: 'kiwisdr',
      },
      { id: 'b', name: 'bad', url: 'http://b.example/', lat: 91, lon: 6 },
      {
        id: 'c',
        name: 'odd',
        url: 'http://c.example/',
        lat: 1,
        lon: 1,
        type: 'martian',
      },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'kiwisdr');
  assert.equal(rows[1].type, 'sdr');
  assert.equal(rows[1].bands, null);
  const kiwi = normalizeSdrDirectory({
    receivers: [
      {
        id: 'k',
        name: 'k',
        url: 'http://k.example/',
        lat: 1,
        lon: 1,
        type: 'kiwisdr',
      },
    ],
  });
  assert.deepEqual(
    kiwi[0].bands,
    [0, 30_000_000],
    'KiwiSDR hardware range is assumed when the directory omits it',
  );
  assert.equal(normalizeSdrDirectory({}), null);
  const html = normalizeSdrDirectory({
    receivers: [
      {
        id: 'h',
        name: '<font color=white>P2000 WebSDR Ulft </font><font color=red>MOVED</font>\uFFFD',
        url: 'http://h.example/',
        lat: 1,
        lon: 1,
        type: 'openwebrx',
      },
    ],
  });
  assert.equal(html[0].name, 'P2000 WebSDR Ulft MOVED');
  const cut = normalizeSdrDirectory({
    receivers: [
      {
        id: 's',
        name: 'Emoji cut \uD83D',
        url: 'http://s.example/',
        lat: 1,
        lon: 1,
      },
    ],
  });
  assert.equal(cut[0].name, 'Emoji cut');
});

test('tuned URLs follow each software family syntax', () => {
  const at = (type) => ({ url: 'http://rx.example:8073/', type });
  assert.equal(
    sdrTunedUrl(at('kiwisdr'), { freqHz: 7_055_000, mode: 'lsb' }),
    'http://rx.example:8073/?f=7055lsbz8',
  );
  assert.equal(
    sdrTunedUrl(at('websdr'), { freqHz: 14_074_000, mode: 'usb' }),
    'http://rx.example:8073/?tune=14074usb',
  );
  assert.equal(
    sdrTunedUrl(at('websdr'), { freqHz: 145_500_000, mode: 'fm' }),
    'http://rx.example:8073/?tune=145500fm',
  );
  assert.equal(
    sdrTunedUrl(at('openwebrx'), { freqHz: 3_573_000, mode: 'usb' }),
    'http://rx.example:8073/#freq=3573000,mod=usb',
  );
  assert.equal(
    sdrTunedUrl(at('ubersdr'), { freqHz: 1_000_000 }),
    'http://rx.example:8073/?freq=1000000&mode=am',
  );
  assert.equal(
    sdrTunedUrl(at('novasdr'), { freqHz: 1_000_000 }),
    'http://rx.example:8073/?frequency=1000000&modulation=AM',
  );
  assert.equal(sdrTunedUrl(at('kiwisdr'), {}), 'http://rx.example:8073/');
  assert.equal(
    sdrTunedUrl(at('kiwisdr'), { freqHz: 4625.5 * 1000 }),
    'http://rx.example:8073/?f=4625.5amz8',
  );
  assert.equal(sdrBandText([0, 30e6]), '0–30 MHz');
  assert.equal(sdrCoversFrequency({ bands: [0, 30e6] }, 7e6), true);
  assert.equal(sdrCoversFrequency({ bands: [0, 30e6] }, 145e6), false);
  assert.equal(sdrCoversFrequency({ bands: null }, 145e6), null);
});

test('bundled source honors cancellation with an uncooperative transport', async () => {
  const abort = new AbortController();
  const source = createBundledSdrSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { receivers: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

function harness(rows, opened) {
  const dataSources = [];
  const viewer = {
    dataSources: {
      add: (d) => dataSources.push(d),
      remove: (d) => dataSources.splice(dataSources.indexOf(d), 1),
    },
    entities: { add: (e) => e, remove() {} },
    scene: { canvas: {} },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-77, 38.9, 2_000_000),
      heading: 0,
      pitch: -1.2,
      roll: 0,
    },
  };
  const layer = createSdrLayer({
    source: { getSnapshot: async () => ({ rows, builtAt: '2026-09-17' }) },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    openUrl: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, dataSources };
}

const rx = (id, lat, lon, type = 'kiwisdr', bands = [0, 30e6]) => ({
  id,
  name: id,
  url: `http://${id}.example:8073/`,
  lat,
  lon,
  type,
  bands,
  antenna: null,
  hw: null,
  usersMax: 4,
  src: 'test',
});

test('layer loads the directory, finds nearest receivers by frequency, and hands off tuned', async () => {
  const opened = [];
  const h = harness(
    [
      rx('near', 52, 6),
      rx('far', 40, -100),
      rx('vhf', 52.1, 6.1, 'openwebrx', [144e6, 146e6]),
    ],
    opened,
  );
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.layer.getStats().count, 3);
  assert.equal(h.layer.getStats().coverage, 'snapshot 2026-09-17');
  const hf = h.layer.findSdrReceivers({
    lat: 52,
    lon: 6,
    freqHz: 7e6,
    limit: 2,
  });
  assert.deepEqual(
    hf.map((r) => r.id),
    ['near', 'far'],
  );
  const vhf = h.layer.findSdrReceivers({ lat: 52, lon: 6, freqHz: 145e6 });
  assert.deepEqual(
    vhf.map((r) => r.id),
    ['vhf'],
  );
  assert.equal(h.layer.selectSdrReceiver('vhf'), true);
  h.layer.setSdrTune({ freqHz: 145_500_000, mode: 'fm' });
  assert.equal(
    h.layer.openSelectedSdrReceiver(),
    'http://vhf.example:8073/#freq=145500000,mod=nbfm',
  );
  assert.deepEqual(opened, [
    'http://vhf.example:8073/#freq=145500000,mod=nbfm',
  ]);
  h.layer.clearSdrSelection();
  assert.equal(h.layer.openSelectedSdrReceiver(), null);
  assert.equal(h.layer.getAnalystRecords().length, 3);
  h.layer.destroy(h.viewer);
  assert.equal(h.dataSources.length, 0);
});

test('per-profile ranges decide coverage; coveredOnly skips receivers with no published range', () => {
  const rows = normalizeSdrDirectory({
    receivers: [
      {
        ...rx('multi', 45, -122, 'openwebrx', null),
        ranges: [
          [118e6, 120.4e6, 'Airband (low)'],
          [144e6, 148e6, '2 m'],
          [10, 5, 'bad'],
        ],
      },
      rx('blank', 45.1, -122.1, 'openwebrx', null),
    ],
  });
  const multi = rows.find((r) => r.id === 'multi');
  assert.deepEqual(multi.bands, [118e6, 148e6], 'envelope derived from ranges');
  assert.equal(multi.ranges.length, 2);
  assert.equal(sdrCoversFrequency(multi, 119e6), true);
  assert.equal(
    sdrCoversFrequency(multi, 121e6),
    false,
    'inside the envelope but between profiles',
  );
  assert.equal(
    sdrCoversFrequency(
      rows.find((r) => r.id === 'blank'),
      121e6,
    ),
    null,
  );
});

test('listenSdr picks the nearest covering receiver, opens it tuned in the dock, and lazy-loads the directory', async () => {
  const opened = [];
  const dataSources = [];
  const viewer = {
    dataSources: {
      add: (d) => dataSources.push(d),
      remove: (d) => dataSources.splice(dataSources.indexOf(d), 1),
    },
    entities: { add: (e) => e, remove() {} },
    scene: { canvas: {} },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-122, 45, 2_000_000),
      heading: 0,
      pitch: -1.2,
      roll: 0,
    },
  };
  let loads = 0;
  const layer = createSdrLayer({
    source: {
      getSnapshot: async () => {
        loads++;
        return {
          rows: [
            rx('air', 45.5, -122.6, 'openwebrx', [118e6, 137e6]),
            rx('hf', 45.4, -122.5),
            rx('unknown', 45.45, -122.55, 'websdr', null),
          ],
          builtAt: '2026-09-17',
        };
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    openUrl: (url, meta) => opened.push({ url, meta }),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  layer.init(viewer);
  // Layer still disabled: the directory loads on demand and the hand-off goes straight to the opener.
  const hit = await layer.listenSdr({
    freqHz: 121e6,
    mode: 'am',
    lat: 45.5,
    lon: -122.6,
  });
  assert.equal(loads, 1);
  assert.equal(
    hit.receiver.id,
    'air',
    'the unknown-range receiver is skipped, the HF one does not cover',
  );
  assert.equal(hit.url, 'http://air.example:8073/#freq=121000000,mod=am');
  assert.equal(opened.at(-1).meta.kind, 'sdr');
  assert.match(opened.at(-1).meta.subtitle, /121\.000 MHz AM · OpenWebRX/);
  assert.equal(
    await layer.listenSdr({ freqHz: 400e6, lat: 45.5, lon: -122.6 }),
    null,
  );
  assert.equal(
    await layer.listenSdr({ freqHz: 121e6, lat: 0, lon: 0, maxKm: 100 }),
    null,
    'out of range',
  );
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(loads, 1, 'enable reuses the lazy load');
  const again = await layer.listenSdr({
    freqHz: 7.1e6,
    mode: 'lsb',
    lat: 45.4,
    lon: -122.5,
  });
  assert.equal(again.receiver.id, 'hf');
  assert.equal(
    layer.getSelectedSdrReceiver().id,
    'hf',
    'selected on the globe once enabled',
  );
  assert.equal(layer.getSdrUIState().tune.freqHz, 7.1e6);
  layer.destroy(viewer);
});

test('the place a name claims is pulled out conservatively, and never guessed', () => {
  assert.equal(
    sdrStatedPlace('W4JCW | Camden, South Carolina USA'),
    'Camden, South Carolina USA',
  );
  assert.equal(
    sdrStatedPlace('0-30 MHz | Guipry-Messac, FRANCE'),
    'Guipry-Messac, FRANCE',
  );
  assert.equal(
    sdrStatedPlace('🌲46º North #1 ~ K9DXI, Presque Isle, Wisconsin | USA🌲'),
    'Presque Isle, Wisconsin',
  );
  assert.equal(
    sdrStatedPlace('0-30 MHz -YO8SGV- KN37EX- KiwiSDR | Dorohoi, Romania'),
    'Dorohoi, Romania',
  );
  assert.equal(
    sdrStatedPlace('0-30 KiwiSDR2 | Hamamatsu, Japan'),
    'Hamamatsu, Japan',
  );
  // A locator square, a callsign, a bare town with no region: no claim.
  assert.equal(
    sdrStatedPlace('0-30 MHz DL0MZ DARC OV-MAINZ | JN49AV @ DF7PN'),
    null,
  );
  assert.equal(sdrStatedPlace('Kissinger Hütte'), null);
  assert.equal(sdrStatedPlace('"Station B" #2 | Canterbury UK'), null);
  assert.equal(sdrStatedPlace(null), null);
});

test('the audit flags a pin far from its stated place, and the layer carries the mark through', async () => {
  const camden = {
    lat: 34.2465,
    lon: -80.607,
    box: [34.216, 34.3, -80.658, -80.537],
  };
  const virginia = {
    lat: 37.5,
    lon: -78.5,
    box: [36.54, 39.47, -83.68, -75.24],
  };
  const grevenMv = { lat: 53.7, lon: 12.1, box: [53.6, 53.8, 12.0, 12.2] };
  const grevenNrw = { lat: 52.09, lon: 7.61, box: [52.0, 52.2, 7.5, 7.7] };
  const lookup = async (q) =>
    q.startsWith('Camden')
      ? [camden]
      : q === 'Virginia, USA'
        ? [virginia]
        : q === 'Greven, Germany'
          ? [grevenMv, grevenNrw]
          : [];
  const misplaced = {
    name: 'W4JCW | Camden, South Carolina USA',
    lat: 28.05,
    lon: -80.56,
  };
  const far = await auditReceiver(misplaced, lookup);
  assert.equal(far.status, 'far');
  assert.equal(far.stated, 'Camden, South Carolina USA');
  assert.ok(far.km > 600 && far.km < 720, `${far.km} km`);
  const ok = await auditReceiver(
    { ...misplaced, lat: 34.25, lon: -80.6 },
    lookup,
  );
  assert.equal(ok.status, 'ok');
  assert.ok(ok.km < FAR_KM);
  assert.equal(
    (await auditReceiver({ name: 'Kissinger Hütte', lat: 50, lon: 9 }, lookup))
      .status,
    'unplaced',
  );
  assert.equal(
    (
      await auditReceiver(
        { name: 'X | Nowhere, Atlantis', lat: 0, lon: 0 },
        lookup,
      )
    ).status,
    'unresolved',
  );
  // A state-level claim is met anywhere inside the state, however far from its centre.
  assert.equal(
    (
      await auditReceiver(
        { name: 'K1RA | Virginia, USA', lat: 38.74, lon: -77.8 },
        lookup,
      )
    ).status,
    'ok',
  );
  const montana = {
    lat: 47,
    lon: -109.6,
    box: [44.36, 49.0, -116.05, -104.04],
  };
  const viaRegion = async (q) =>
    q === 'Montana, USA'
      ? [montana]
      : q === 'W. Montana, USA'
        ? [{ lat: 40, lon: -75, box: null }]
        : [];
  assert.equal(
    (
      await auditReceiver(
        { name: 'W0AY | W. Montana, USA', lat: 46.59, lon: -114.03 },
        viaRegion,
      )
    ).status,
    'ok',
  );
  assert.equal(
    (
      await auditReceiver(
        { name: 'K7KIB | West Valley, OR', lat: 45.03, lon: -123.4 },
        async (q) =>
          q === 'West Valley, OR'
            ? [{ lat: 45.05, lon: -123.4, box: null }]
            : [{ lat: 0, lon: 0, box: null }],
      )
    ).status,
    'ok',
  );
  // The operator meant whichever Greven they are near, not the first one Nominatim lists.
  assert.equal(
    (
      await auditReceiver(
        { name: 'DF1QQ | Greven, Germany', lat: 52.13, lon: 7.55 },
        lookup,
      )
    ).status,
    'ok',
  );
  // A KiwiSDR never renamed says Tauranga; that is the product's default, not a claim.
  assert.equal(
    (
      await auditReceiver(
        {
          name: '0-30 MHz SDR | Tauranga, New Zealand',
          lat: 39.2,
          lon: -84.58,
        },
        async () => [
          { lat: -37.69, lon: 176.17, box: [-37.8, -37.6, 176.1, 176.3] },
        ],
      )
    ).status,
    'placeholder',
  );
  // A slash in a name is not a separator: "MA/CT Border" is one thing, and not a claim.
  assert.equal(sdrStatedPlace('N1NTE-3 - MA/CT Border, USA'), null);
  // A direction in front of a region is tried as the region, second: the
  // geocoder knows Montana, not "W. Montana" — but "West Valley" is a town.
  assert.equal(
    sdrStatedPlace('W0AY: kiwiSDR @1 0.1-30 MHz | W. Montana, USA'),
    'W. Montana, USA',
  );
  assert.equal(sdrRegionWithoutDirection('W. Montana, USA'), 'Montana, USA');
  assert.equal(
    sdrRegionWithoutDirection('Northern Virginia, USA'),
    'Virginia, USA',
  );
  assert.equal(sdrRegionWithoutDirection('Camden, South Carolina USA'), null);

  const rows = normalizeSdrDirectory({
    receivers: [
      {
        ...misplaced,
        id: 'a',
        url: 'http://a.example/',
        type: 'kiwisdr',
        placeStated: far.stated,
        placeKm: far.km,
      },
      {
        ...misplaced,
        id: 'b',
        url: 'http://b.example/',
        type: 'kiwisdr',
        placeKm: 0,
      },
      {
        ...misplaced,
        id: 'c',
        name: '0-30 MHz SDR | Tauranga, New Zealand',
        url: 'http://c.example/',
        type: 'kiwisdr',
        placeDefault: true,
      },
    ],
  });
  assert.equal(rows[2].placeDefault, true);
  assert.ok(
    createSdrSelectedOverlayEntry({
      id: 'sdr:c',
      position: null,
      receiver: rows[2],
    }).details.some((d) => /default location/.test(d)),
  );
  assert.equal(rows[0].placeMismatchKm, far.km);
  assert.equal(rows[0].placeStated, 'Camden, South Carolina USA');
  assert.equal(rows[1].placeMismatchKm, null);
  const entry = createSdrSelectedOverlayEntry({
    id: 'sdr:a',
    position: null,
    receiver: rows[0],
  });
  assert.ok(
    entry.details.some(
      (d) => /position unverified/.test(d) && /Camden/.test(d),
    ),
    entry.details.join('|'),
  );
  assert.equal(mapSdrAnalystRecord(rows[0]).placeMismatchKm, far.km);
  assert.ok(
    !createSdrSelectedOverlayEntry({
      id: 'sdr:b',
      position: null,
      receiver: rows[1],
    }).details.some((d) => /unverified/.test(d)),
  );
});

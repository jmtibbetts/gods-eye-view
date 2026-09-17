import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSdrDirectory, sdrReceiverUrl } from './records.js';
import { sdrBandText, sdrCoversFrequency, sdrTunedUrl } from './model.js';
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

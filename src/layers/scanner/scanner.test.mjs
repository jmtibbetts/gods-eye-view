import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  normalizeScannerCalls,
  normalizeScannerGroups,
  normalizeScannerSeed,
  normalizeScannerSystems,
  normalizeScannerTalkgroups,
  scannerAudioUrl,
} from './records.js';
import { createScannerPlayer } from './player.js';
import { createOpenMhzSource } from './source.js';
import { createScannerLayer } from './index.js';
import { scannerActivityBand, scannerCallLine, scannerPlace } from './model.js';

const AUDIO =
  'https://media2.openmhz.com/media/dcfd/101/dcfd-101-1789616870.m4a';

test('audio URLs are pinned to the OpenMHz media host', () => {
  assert.equal(scannerAudioUrl(AUDIO), AUDIO);
  assert.equal(scannerAudioUrl('http://media2.openmhz.com/media/x.m4a'), null);
  assert.equal(scannerAudioUrl('https://evil.example/media/x.m4a'), null);
  assert.equal(
    scannerAudioUrl('https://media2.openmhz.com/x.m4a?token=1'),
    null,
  );
  assert.equal(scannerAudioUrl('https://media2.openmhz.com/x.exe'), null);
});

test('seed normalization rejects the whole file on a bad row', () => {
  const good = {
    systems: [{ id: 'dcfd', name: 'DC Fire', lat: 38.9, lon: -77, callAvg: 3 }],
  };
  assert.equal(normalizeScannerSeed(good).length, 1);
  assert.equal(
    normalizeScannerSeed({ systems: [{ id: 'dcfd', lat: 999, lon: 0 }] }),
    null,
  );
  assert.equal(
    normalizeScannerSeed({ systems: [{ id: 'a b', lat: 1, lon: 1 }] }),
    null,
  );
  assert.equal(
    normalizeScannerSeed({
      systems: [
        { id: 'x', lat: 1, lon: 1 },
        { id: 'x', lat: 1, lon: 1 },
      ],
    }),
    null,
  );
  assert.equal(normalizeScannerSeed({}), null);
});

test('live systems and calls tolerate bad rows individually', () => {
  const systems = normalizeScannerSystems({
    systems: [
      {
        shortName: 'dcfd',
        callAvg: 4.2,
        active: true,
        lastActive: '2026-09-17T00:00:00Z',
        clientCount: 9,
      },
      { shortName: 'bad id!', callAvg: 1 },
      null,
    ],
  });
  assert.equal(systems.size, 1);
  assert.equal(systems.get('dcfd').callAvg, 4.2);
  const calls = normalizeScannerCalls({
    calls: [
      {
        _id: 'a',
        time: '2026-09-17T04:00:00.000Z',
        talkgroupNum: 101,
        len: 8,
        url: AUDIO,
        srcList: [{ tag: 'E1' }],
      },
      { _id: 'b', time: 'nope', talkgroupNum: 101, url: AUDIO },
      {
        _id: 'c',
        time: '2026-09-17T04:00:01.000Z',
        talkgroupNum: 102,
        url: 'https://evil.example/x.m4a',
      },
    ],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].units, ['E1']);
  assert.equal(normalizeScannerCalls({ nope: 1 }), null);
});

test('talkgroup and group labels join by number', () => {
  const tgs = normalizeScannerTalkgroups({
    talkgroups: {
      101: { num: 101, alpha: '01 disp', description: 'Fire Dispatch' },
    },
  });
  assert.equal(tgs.get(101).description, 'Fire Dispatch');
  const groups = normalizeScannerGroups([
    { groupName: 'Fire', talkgroups: [101, 102] },
    { groupName: 'EMS', talkgroups: [102] },
  ]);
  assert.equal(groups.get(101), 'Fire');
  assert.equal(groups.get(102), 'Fire');
  const line = scannerCallLine(
    {
      talkgroup: 101,
      time: 1000,
      len: 7.6,
      units: ['E1', 'T4', 'B2'],
      emergency: true,
    },
    new Map([
      [101, { alpha: '01 disp', description: 'Fire Dispatch', group: 'Fire' }],
    ]),
    { now: 5000 },
  );
  assert.match(line, /^🔥 Fire Dispatch ‼ · 8s · 4s · E1 T4$/);
});

test('activity band and place text', () => {
  assert.equal(scannerActivityBand({ callAvg: 12 }), 'hot');
  assert.equal(scannerActivityBand({ callAvg: 0.5 }), 'quiet');
  assert.equal(scannerActivityBand({ callAvg: 12, active: false }), 'idle');
  assert.equal(
    scannerPlace({ city: 'Chicago', state: 'IL', country: 'USA' }),
    'Chicago, IL',
  );
  assert.equal(
    scannerPlace({ county: 'King', state: 'WA' }),
    'King County, WA',
  );
  assert.equal(scannerPlace({ country: 'Canada' }), 'Canada');
});

function fakeAudio() {
  const listeners = new Map();
  const audio = {
    volume: 1,
    src: null,
    played: [],
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    play() {
      audio.played.push(audio.src);
      return Promise.resolve();
    },
    pause() {},
    load() {},
    removeAttribute() {
      audio.src = null;
    },
    fire(name) {
      listeners.get(name)?.();
    },
  };
  return audio;
}

test('player queues calls in order, dedupes, and steps on ended', () => {
  const audio = fakeAudio();
  const states = [];
  const player = createScannerPlayer({
    createAudio: () => audio,
    queueLimit: 3,
    onChange: (s) => states.push(s.state),
  });
  const call = (id) => ({ id, url: `${AUDIO}#${id}`, time: 0 });
  assert.equal(player.enqueue([call('a'), call('b'), call('a')]), 2);
  assert.equal(audio.played.length, 1);
  assert.equal(player.getState().current.id, 'a');
  audio.fire('ended');
  assert.equal(player.getState().current.id, 'b');
  audio.fire('ended');
  assert.equal(player.getState().state, 'idle');
  // over the cap: oldest queued are dropped, not the one playing
  player.enqueue([call('c'), call('d'), call('e'), call('f'), call('g')]);
  assert.equal(
    player.getState().current.id,
    'e',
    'oldest clips are dropped, newest traffic plays',
  );
  assert.equal(player.getState().queued, 2);
  assert.equal(player.getState().dropped, 2);
  player.pause();
  audio.fire('ended');
  assert.equal(player.getState().state, 'paused');
  player.resume();
  assert.equal(player.getState().current.id, 'f');
  player.stop();
  assert.equal(player.getState().state, 'idle');
  assert.equal(player.getState().queued, 0);
});

test('source validates ids and honors abort', async () => {
  const source = createOpenMhzSource({
    fetchImpl: async (url) => ({ ok: true, json: async () => ({ calls: [] }) }),
    seedUrl: 'https://seed.test/systems.json',
  });
  await assert.rejects(
    source.getRecentCalls('../etc'),
    /Invalid scanner system id/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    source.getRecentCalls('dcfd', { signal: abort.signal }),
    { name: 'AbortError' },
  );
});

function harness(source, { enable = true } = {}) {
  const dataSources = [];
  const overlay = [];
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
  const layer = createScannerLayer({
    source,
    overlayHost: {
      setEntries: (...a) => overlay.push(a),
      setVisible() {},
      clearSource() {},
    },
    createAudio: fakeAudio,
    now: () => 1_000_000,
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  layer.init(viewer);
  if (enable) layer.enable(viewer);
  return { layer, viewer, dataSources, overlay };
}

const seedRow = {
  id: 'dcfd',
  name: 'DC Fire and EMS',
  type: 'city',
  city: 'Washington',
  state: 'DC',
  country: 'USA',
  lat: 38.9,
  lon: -77,
  callAvg: 3,
  active: true,
  clientCount: 0,
  lastActive: null,
  precision: 'city',
  desc: null,
};

test('layer paints the seed even when the live catalog fails, and honors disable mid-flight', async () => {
  const source = {
    getSeed: async () => [seedRow],
    getSystems: async () => {
      throw new Error('cloudflare challenge');
    },
    getRecentCalls: async () => [],
    getNewerCalls: async () => [],
  };
  const h = harness(source);
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getStats().error, 'OpenMHz catalog unavailable');
  assert.ok(h.overlay.length >= 1);
  assert.equal(h.layer.findScannerSystems('dc fire')[0].id, 'dcfd');
  assert.equal(h.layer.getAnalystRecords()[0].place, 'Washington, DC');

  let resolve;
  const slow = { ...source, getSeed: () => new Promise((r) => (resolve = r)) };
  const h2 = harness(slow);
  const pending = h2.layer.update(h2.viewer);
  h2.layer.disable();
  resolve([seedRow]);
  assert.equal(await pending, false);
  assert.equal(h2.layer.getStats().count, 0);
  h.layer.destroy(h.viewer);
  h2.layer.destroy(h2.viewer);
  assert.equal(h.dataSources.length, 0);
});

test('selecting a system starts a live session and stopping tears it down', async () => {
  let newerCalls = 0;
  const source = {
    getSeed: async () => [seedRow],
    getSystems: async () =>
      new Map([
        [
          'dcfd',
          {
            active: true,
            lastActive: null,
            callAvg: 9,
            clientCount: 2,
            name: null,
          },
        ],
      ]),
    getTalkgroups: async () =>
      new Map([[101, { alpha: '01', description: 'Fire Dispatch' }]]),
    getGroups: async () => new Map(),
    getRecentCalls: async () => [
      {
        id: 'old',
        time: 1_000_000 - 500_000,
        talkgroup: 101,
        len: 5,
        freq: null,
        emergency: false,
        units: [],
        url: AUDIO,
      },
      {
        id: 'fresh',
        time: 1_000_000 - 10_000,
        talkgroup: 101,
        len: 5,
        freq: null,
        emergency: false,
        units: [],
        url: AUDIO,
      },
    ],
    getNewerCalls: async () => {
      newerCalls++;
      return [];
    },
  };
  const h = harness(source);
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getScannerUIState().systems, 1);
  assert.equal(h.layer.selectScannerSystem('nope'), false);
  assert.equal(h.layer.selectScannerSystem('dcfd'), true);
  await new Promise((r) => setTimeout(r, 20));
  const ui = h.layer.getScannerUIState();
  assert.equal(ui.selected, 'dcfd');
  assert.equal(ui.session.status, 'live');
  assert.equal(ui.session.calls, 2);
  // only the fresh clip is queued/played; the stale one is history
  assert.equal(ui.player.current.id, 'fresh');
  assert.match(h.layer.getStats().loadingLabel, /LIVE · DC Fire/);
  h.layer.stopScanner();
  assert.equal(h.layer.getScannerUIState().selected, null);
  assert.equal(h.layer.getScannerUIState().player.state, 'idle');
  const polls = newerCalls;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(newerCalls, polls, 'no polling after stop');
  h.layer.destroy(h.viewer);
});

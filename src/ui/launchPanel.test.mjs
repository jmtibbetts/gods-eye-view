import test from 'node:test';
import assert from 'node:assert/strict';
import { LaunchPanel, mhzText } from './launchPanel.js';

const NOW = Date.parse('2026-09-19T12:00:00Z');

test('frequencies read the way they are said on the air', () => {
  assert.equal(mhzText(128.55), '128.55');
  assert.equal(mhzText(118.9), '118.9');
  assert.equal(mhzText(121), '121.0');
  assert.equal(mhzText(133.125), '133.125');
  assert.equal(mhzText(NaN), '');
});

/* ------------------------------------------------------------------ *
 * DOM double — enough of an element to exercise render and clicks.
 * ------------------------------------------------------------------ */

function makeElement(tag) {
  let text = '';
  const node = {
    tagName: tag,
    className: '',
    dataset: {},
    children: [],
    _listeners: {},
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = String(value);
      node.children = [];
    },
    setAttribute(k, v) {
      node.dataset[`attr_${k}`] = v;
    },
    append(...kids) {
      node.children.push(...kids);
    },
    addEventListener(type, fn) {
      (node._listeners[type] ||= []).push(fn);
    },
    click() {
      (node._listeners.click || []).forEach((fn) => fn());
    },
  };
  return node;
}

async function withFakeDom(run) {
  const prior = globalThis.document;
  globalThis.document = { createElement: (tag) => makeElement(tag) };
  try {
    return await run();
  } finally {
    globalThis.document = prior;
  }
}

function* walk(root) {
  for (const child of root.children || []) {
    yield child;
    yield* walk(child);
  }
}

function findAll(root, className) {
  return [...walk(root)].filter((n) =>
    String(n.className).split(' ').includes(className),
  );
}

function ll2(overrides = {}) {
  return {
    id: 'abc-123',
    name: 'Falcon 9 Block 5 | Starlink Group 15-27',
    status: { abbrev: 'Go', name: 'Go for Launch' },
    net: '2026-09-19T14:30:00Z',
    net_precision: { name: 'Second' },
    probability: 90,
    webcast_live: false,
    launch_service_provider: { name: 'SpaceX' },
    rocket: { configuration: { full_name: 'Falcon 9 Block 5' } },
    pad: {
      name: 'Space Launch Complex 40',
      latitude: '28.562',
      longitude: '-80.577',
      location: { name: 'Cape Canaveral SFS, FL, USA' },
    },
    vid_urls: [
      {
        priority: 10,
        source: 'youtube.com',
        publisher: 'SpaceX',
        title: 'Starlink Mission',
        url: 'https://www.youtube.com/watch?v=AnN8Pj8WvSo',
        live: false,
      },
    ],
    updates: [{ comment: 'Go for launch.', created_on: '2026-09-19T10:00:00Z' }],
    ...overrides,
  };
}

/** A window double whose timers never fire on their own. */
function fakeWindow() {
  const timers = [];
  return {
    timers,
    setInterval(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval(id) {
      timers[id - 1] = null;
    },
  };
}

function panelWith({ results = [ll2()], now = NOW, fetchStatus = 200, layers = {} } = {}) {
  const elements = {
    state: makeElement('span'),
    body: makeElement('div'),
    note: makeElement('p'),
  };
  const docked = [];
  const tabs = [];
  const toasts = [];
  const enabled = new Set();
  let clock = now;
  const windowRef = fakeWindow();
  const panel = new LaunchPanel({
    elements,
    fetchImpl: async () => ({
      ok: fetchStatus === 200,
      status: fetchStatus,
      json: async () => ({ results }),
    }),
    viewer: null,
    openInDock: (url, meta) => docked.push({ url, meta }),
    openTab: (url) => tabs.push(url),
    scanner: () => layers.scanner || null,
    atc: () => layers.atc || null,
    sdr: () => layers.sdr || null,
    enableLayer: async (id) => enabled.add(id),
    isLayerEnabled: (id) => enabled.has(id),
    onToast: (m) => toasts.push(m),
    windowRef,
    now: () => clock,
  });
  return {
    panel,
    elements,
    docked,
    tabs,
    toasts,
    enabled,
    windowRef,
    setNow: (t) => {
      clock = t;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('the panel lists the manifest with a live clock, and the header names the next one', async () => {
  await withFakeDom(async () => {
    const { panel, elements, windowRef, setNow } = panelWith();
    panel.connect();
    await settle();
    assert.equal(findAll(elements.body, 'launch-row').length, 1);
    assert.equal(findAll(elements.body, 'launch-clock')[0].textContent, 'T−02:30:00');
    assert.equal(findAll(elements.body, 'launch-chip')[0].textContent, 'GO');
    assert.equal(elements.state.textContent, 'T−02:30:00 · FALCON 9 BLOCK 5');
    assert.match(findAll(elements.body, 'launch-meta')[0].textContent, /SpaceX · Falcon 9 Block 5/);
    assert.match(findAll(elements.body, 'launch-update')[0].textContent, /Go for launch/);
    // One second later the clock moved without a rebuild.
    const clock = findAll(elements.body, 'launch-clock')[0];
    setNow(NOW + 1000);
    panel.tick();
    assert.equal(clock.textContent, 'T−02:29:59');
    assert.equal(findAll(elements.body, 'launch-clock')[0], clock);
    // Crossing T-0 as a Go launch flips the chip to IN FLIGHT, which rebuilds.
    setNow(Date.parse('2026-09-19T14:30:05Z'));
    panel.tick();
    assert.equal(findAll(elements.body, 'launch-chip')[0].textContent, 'IN FLIGHT');
    assert.equal(findAll(elements.body, 'launch-clock')[0].textContent, 'T+00:00:05');
    assert.equal(elements.state.textContent, 'IN FLIGHT · FALCON 9 BLOCK 5');
    assert.equal(windowRef.timers.filter(Boolean).length, 2, 'refresh and tick timers');
    panel.destroy();
    assert.equal(windowRef.timers.filter(Boolean).length, 0, 'timers cleared');
  });
});

test('WATCH frames a YouTube webcast in the dock and opens anything else in its own tab', async () => {
  await withFakeDom(async () => {
    const { panel, elements, docked, tabs, toasts } = panelWith({
      results: [
        ll2(),
        ll2({
          id: 'x-only',
          name: 'Electron | Owl',
          net: '2026-09-20T03:00:00Z',
          vid_urls: [{ url: 'https://x.com/i/broadcasts/1', publisher: 'SpaceX', title: 'Starlink' }],
        }),
        ll2({ id: 'silent', name: 'Long March 2D | PIESAT', net: '2026-09-21T03:00:00Z', vid_urls: [] }),
      ],
    });
    panel.connect();
    await settle();
    const watch = findAll(elements.body, 'launch-btn-watch');
    assert.equal(watch.length, 2);
    watch[0].click();
    assert.equal(docked.length, 1);
    assert.match(docked[0].url, /youtube-nocookie\.com\/embed\/AnN8Pj8WvSo/);
    assert.equal(docked[0].meta.kind, 'video');
    assert.match(docked[0].meta.note, /operator/);
    watch[1].click();
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0], 'https://x.com/i/broadcasts/1');
    assert.match(toasts.at(-1), /own tab/);
    assert.equal(findAll(elements.body, 'launch-nocast').length, 1, 'no webcast says so');
    panel.destroy();
  });
});

test('LISTEN names the range system, the tower and the receivers, and says which cannot hear', async () => {
  await withFakeDom(async () => {
    const seedAsked = [];
    const scanner = {
      ensureScannerSeed: async () => seedAsked.push('scanner'),
      nearestScannerSystems: () => [
        { id: 'nasaksc', name: 'Kennedy Space Center', desc: 'NASA Kennedy Space Center', county: 'Brevard', state: 'FL', distanceKm: 48, callAvg: 0.9 },
      ],
      selectScannerSystem: (id) => {
        seedAsked.push(`select:${id}`);
        return true;
      },
    };
    const atc = {
      ensureAtcDirectory: async () => seedAsked.push('atc'),
      findAtcAirports: () => [
        { id: 'KTTS', name: 'Space Florida Launch and Landing Facility', call: 'Nasa', towered: true, distanceKm: 9, freqs: [{ position: 'TWR', mhz: 128.55 }, { position: 'APP', mhz: 134.95 }] },
      ],
      listenAtc: async ({ airportId, position }) => {
        seedAsked.push(`listen:${airportId}:${position}`);
        return { airportId };
      },
    };
    const sdr = {
      ensureSdrDirectory: async () => seedAsked.push('sdr'),
      findSdrReceivers: () => [
        { id: 'hf', name: '0-30 MHz SDR | Indian Harbour Beach', type: 'kiwisdr', url: 'http://a/', distanceKm: 50, bands: [0, 30_000_000] },
      ],
      listenSdr: async () => null,
    };
    const { panel, elements, enabled, toasts } = panelWith({ layers: { scanner, atc, sdr } });
    panel.connect();
    await settle();
    const listen = findAll(elements.body, 'launch-btn').find((b) => b.textContent === 'LISTEN');
    listen.click();
    await settle();
    await settle();
    assert.deepEqual(seedAsked.slice(0, 3).sort(), ['atc', 'scanner', 'sdr']);
    const names = findAll(elements.body, 'launch-source-name').map((n) => n.textContent);
    assert.ok(names.some((n) => /Kennedy Space Center · ON THE RANGE/.test(n)), names.join('|'));
    assert.ok(names.some((n) => /KTTS Nasa · ON THE RANGE/.test(n)), names.join('|'));
    const metas = findAll(elements.body, 'launch-source-meta').map((n) => n.textContent);
    assert.ok(metas.some((m) => /TWR 128.55 · APP 134.95 · 9 km/.test(m)), metas.join('|'));
    assert.ok(metas.some((m) => /HF only/.test(m)), metas.join('|'));
    const notes = findAll(elements.body, 'launch-listen-note').map((n) => n.textContent);
    assert.ok(notes.some((n) => /operator/.test(n) && /WATCH/.test(n)), 'mission audio is on the webcast');
    assert.ok(notes.some((n) => /Not the countdown net/.test(n)));
    assert.ok(notes.some((n) => /HF only/.test(n) && /none of them can hear/.test(n)));
    // LISTEN on the range system turns the scanners on and tunes it.
    const buttons = findAll(elements.body, 'launch-btn-small');
    buttons.find((b) => b.textContent === 'LISTEN').click();
    await settle();
    assert.ok(enabled.has('scanner'));
    assert.ok(seedAsked.includes('select:nasaksc'));
    // LISTEN on the tower turns ATC on and opens the tower position.
    const towerBtn = buttons.filter((b) => b.textContent === 'LISTEN')[1];
    towerBtn.click();
    await settle();
    assert.ok(enabled.has('atc'));
    assert.ok(seedAsked.includes('listen:KTTS:TWR'));
    assert.equal(toasts.length, 0);
    panel.destroy();
  });
});

test('a feed failure keeps the last manifest and says the source is down', async () => {
  await withFakeDom(async () => {
    const { panel, elements } = panelWith({ fetchStatus: 502 });
    panel.connect();
    await settle();
    assert.equal(elements.state.textContent, 'OFFLINE');
    assert.match(findAll(elements.body, 'launch-empty')[0].textContent, /unreachable/);
    panel.destroy();
  });
});

test('with nothing listed the panel says so rather than showing an empty box', async () => {
  await withFakeDom(async () => {
    const { panel, elements } = panelWith({ results: [] });
    panel.connect();
    await settle();
    assert.equal(elements.state.textContent, 'NONE');
    assert.match(findAll(elements.body, 'launch-empty')[0].textContent, /Nothing on the manifest/);
    panel.destroy();
  });
});

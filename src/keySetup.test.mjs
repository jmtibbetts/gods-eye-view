import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectKeyUpdates,
  keySetupChipLabel,
  stripKeylessBasemapFromHash,
  bindKeySetupPlacement,
} from './keySetup.js';

test('setup placement moves the same button only in Cyber and disconnects on teardown', () => {
  const home = {};
  const chip = { parentNode: home, hidden: true };
  const root = { parentNode: home, before: (node) => { node.parentNode = home; } };
  let moves = 0;
  const toolbar = { append: (node) => { moves++; node.parentNode = toolbar; } };
  const theme = { dataset: { uiTheme: 'tactical' } };
  let notify, disconnected = false;
  class Observer {
    constructor(callback) { notify = callback; }
    observe(target, options) {
      assert.equal(target, theme);
      assert.deepEqual(options.attributeFilter, ['data-ui-theme']);
    }
    disconnect() { disconnected = true; }
  }
  const dispose = bindKeySetupPlacement({
    documentElement: theme,
    getElementById: () => toolbar,
    defaultView: { MutationObserver: Observer },
  }, chip, root);
  assert.equal(chip.parentNode, home);
  for (const variant of ['cyber', 'operator', 'cyber', 'minimal']) {
    theme.dataset.uiTheme = variant;
    notify();
    assert.equal(chip.parentNode, variant === 'cyber' ? toolbar : home);
    notify();
  }
  assert.equal(moves, 2, 'identical theme sync does not reparent again');
  assert.equal(chip.hidden, true, 'placement cannot reveal a retired button');
  dispose();
  assert.equal(disconnected, true);
});

test('the chip counts what is missing, and retires the count at zero', () => {
  assert.equal(keySetupChipLabel({ setCount: 0, total: 8 }), 'POWER UP · 8 KEYS WAITING');
  assert.equal(keySetupChipLabel({ setCount: 7, total: 8 }), 'POWER UP · 1 KEY WAITING');
  assert.equal(keySetupChipLabel({ setCount: 8, total: 8 }), 'POWERED UP');
  assert.equal(keySetupChipLabel(null), 'POWERED UP', 'no status is not a broken label');
});

test('collectKeyUpdates keeps only non-empty trimmed values', () => {
  const updates = collectKeyUpdates([
    { envVar: 'OPENAI_API_KEY', value: '  sk-abc  ' },
    { envVar: 'FIRMS_MAP_KEY', value: '' },
    { envVar: 'TOMTOM_API_KEY', value: '   ' },
    { envVar: '', value: 'orphan' },
    null,
  ]);
  assert.deepEqual(updates, { OPENAI_API_KEY: 'sk-abc' });
  assert.deepEqual(collectKeyUpdates([]), {});
  assert.deepEqual(collectKeyUpdates(null), {});
});

test('the first Google key strips ONLY the keyless OSM basemap from the share hash', () => {
  const stripped = stripKeylessBasemapFromHash('lat=30.2&lon=-97.7&map=osm&style=normal');
  assert.ok(stripped !== null);
  const params = new URLSearchParams(stripped);
  assert.equal(params.get('map'), null, 'osm basemap removed');
  assert.equal(params.get('lat'), '30.2', 'camera survives');
  assert.equal(params.get('style'), 'normal', 'style survives');
  // A stack under any other name was chosen or shared on purpose.
  assert.equal(stripKeylessBasemapFromHash('map=bing-aerial&lat=1'), null);
  assert.equal(stripKeylessBasemapFromHash('lat=1&lon=2'), null, 'no stack, nothing to do');
  assert.equal(stripKeylessBasemapFromHash(''), null);
  assert.equal(stripKeylessBasemapFromHash(undefined), null);
});

test('aborting pending setup removes its surface and ignores a late response', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const removed = [];
  const chip = { remove: () => removed.push('chip') };
  const root = { dataset: {}, remove: () => removed.push('root') };
  let resolveResponse;
  let requestSignal;
  const controller = new AbortController();
  const pending = initKeySetup({
    documentRef: { getElementById: (id) => id === 'key-setup-chip' ? chip : root },
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => { resolveResponse = resolve; });
    },
  });
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(removed, ['chip', 'root']);
  resolveResponse({ ok: true, json: async () => ({ keys: [] }) });
  assert.equal(await pending, null);
});

test('the dialog lists the keyless sources after the keys, folded, with nothing to paste', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  // A minimal DOM: enough for render() to build rows into the host.
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      classList: { add() {}, remove() {}, contains: () => false },
      attributes: {},
      textContent: '',
      hidden: false,
      append(...nodes) {
        for (const node of nodes) this.children.push(node);
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getClientRects: () => [],
      focus() {},
    };
    return el;
  };
  const rowsHost = make('div');
  const chip = make('button');
  const root = make('aside');
  root.dataset = {};
  root.querySelector = (selector) =>
    selector === '[data-key-setup-rows]' ? rowsHost : null;
  chip.querySelector = () => null;
  const documentRef = {
    getElementById: (id) => (id === 'key-setup-chip' ? chip : root),
    createElement: make,
    addEventListener() {},
    removeEventListener() {},
  };
  await initKeySetup({
    documentRef,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        keys: [
          { id: 'aisstream', title: 'AISSTREAM', unlocks: 'ships', getUrl: 'https://x', envVars: ['AISSTREAM_API_KEY'], tier: 'free', set: false },
        ],
        setCount: 0,
        total: 1,
        keyless: [
          { id: 'celestrak', title: 'CELESTRAK', feeds: 'satellite orbits', url: 'https://celestrak.org', note: '' },
          { id: 'satnogs', title: 'SATNOGS', feeds: 'ground stations', url: 'https://network.satnogs.org', note: 'CC BY-SA 4.0' },
        ],
      }),
    }),
  });
  assert.equal(rowsHost.children.length, 2, 'one keyed row, then the keyless section');
  const [keyed, folded] = rowsHost.children;
  assert.equal(keyed.dataset.keyId, 'aisstream');
  assert.equal(folded.tagName, 'DETAILS', 'keyless sources are folded');
  const [summary, list] = folded.children;
  assert.equal(summary.textContent, 'ALREADY ON · 2 SOURCES, NO KEY NEEDED');
  assert.equal(list.children.length, 2);
  const satnogs = list.children[1];
  assert.equal(satnogs.dataset.set, 'true', 'a keyless source is always lit');
  const inputs = satnogs.children.flatMap((c) => c.children).filter((c) => c.tagName === 'INPUT');
  assert.equal(inputs.length, 0, 'nothing to paste');
  const head = satnogs.children[0];
  const texts = head.children.map((c) => c.textContent);
  assert.ok(texts.includes('SATNOGS'));
  assert.ok(texts.includes('🟢'), 'no-key tier dot');
  assert.ok(texts.includes('ABOUT ↗'));
  const caveat = satnogs.children.find((c) => c.className === 'key-setup-caveat');
  assert.equal(caveat?.textContent, 'CC BY-SA 4.0', 'the caveat is shown on its own line');
  const celestrak = list.children[0];
  assert.equal(celestrak.children.some((c) => c.className === 'key-setup-caveat'), false,
    'no caveat, no badge');
});

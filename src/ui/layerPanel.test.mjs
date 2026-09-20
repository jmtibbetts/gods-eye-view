import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('panel presentation groups rows by the part of the world they draw', () => {
  const source = readFileSync(
    new URL('./layerPanel.js', import.meta.url),
    'utf8',
  );
  const declarations = source.slice(
    source.indexOf('const PANEL_GROUPS ='),
    source.indexOf('const PANEL_POSITIONS ='),
  );
  const order = JSON.parse(
    runInNewContext(`${declarations}\nJSON.stringify(PANEL_ORDER)`),
  );
  assert.deepEqual(
    order.filter(({ label }) => label === 'Sky & space').map(({ id }) => id),
    [
      'flights',
      'military',
      'satellites',
      'rocket-launches',
      'conjunctions',
      'tfr',
      'aviation-hazards',
      'satnogs',
    ],
  );
  assert.deepEqual(
    order.filter(({ label }) => label === 'Ground').map(({ id }) => id),
    [
      'traffic',
      'transit',
      'bikeshare',
      'cctv',
      'alpr-cameras',
      'military-installations',
      'local-datacenters',
      'local-dams',
      'directions',
    ],
  );
  assert.deepEqual(
    order.filter(({ label }) => label === 'Listen').map(({ id }) => id),
    ['radio', 'scanner', 'sdr', 'atc'],
  );
  assert.equal(order.filter(({ id }) => id === 'transit').length, 1);
  assert.equal(new Set(order.map(({ id }) => id)).size, order.length);
});

test('partial feed controls distinguish incomplete records from stale data and outages', async () => {
  const { LayerPanel, layerFeedState } = await import('./layerPanel.js');
  const classes = new Map();
  const attrs = new Map();
  const button = {
    classList: { toggle: (key, value) => classes.set(key, value) },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
  const layer = {
    id: 'ais-live-vessels',
    name: 'Live Vessels',
    source: 'AISStream',
    enabled: true,
    stats: {
      partial: true,
      stale: false,
      count: 2,
      acceptedRowCount: 2,
      rawRowCount: 3,
      lastUpdate: Date.now(),
    },
  };
  const panel = LayerPanel.prototype;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'PARTIAL');
  assert.equal(button.dataset.feedState, 'partial');
  assert.equal(classes.get('feed-partial'), true);
  assert.equal(classes.get('feed-stale'), false);
  assert.match(attrs.get('aria-label'), /PARTIAL/);
  assert.match(
    panel._buildMetaText(layer),
    /^PARTIAL · AISStream · 2 of 3 records accepted · /,
  );
  assert.match(
    panel._buildMetaText({
      ...layer,
      stats: { ...layer.stats, rawRowCount: 2 },
    }),
    /incomplete snapshot/,
  );
  assert.equal(layerFeedState({ ...layer.stats, stale: true }), 'stale');
  assert.equal(
    layerFeedState({ ...layer.stats, error: 'Connection lost' }),
    'degraded',
  );
  assert.equal(
    layerFeedState({ ...layer.stats, status: 'unavailable' }),
    'unavailable',
  );
  assert.equal(layerFeedState({ ...layer.stats, loading: true }), 'loading');
  layer.stats = { ...layer.stats, partial: false };
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'ON');
  assert.equal(classes.get('feed-partial'), false);
  layer.enabled = false;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'OFF');
});

test('a row that is off says where its data comes from, not that it never worked', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const off = {
    id: 'military',
    name: 'Military Flights',
    source: 'adsb.lol',
    enabled: false,
    stats: {},
  };
  // "adsb.lol · never" reads as a source that has never worked. Down a list
  // of forty-three rows, most of them off, it reads as a broken app.
  assert.equal(panel._buildMetaText(off), 'adsb.lol');

  // On and genuinely never fetched is worth saying.
  assert.equal(
    panel._buildMetaText({ ...off, enabled: true }),
    'adsb.lol · never',
  );

  // Off but previously fetched keeps its age: how stale the last snapshot
  // is stays worth knowing.
  assert.match(
    panel._buildMetaText({
      ...off,
      stats: { lastUpdate: Date.now() - 120_000 },
    }),
    /^adsb\.lol · 2m ago$/,
  );
});

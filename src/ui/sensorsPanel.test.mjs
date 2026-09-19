import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SensorsPanel,
  currencyText,
  orbitText,
  productsForPlatform,
} from './sensorsPanel.js';
import {
  IMAGING_PLATFORMS,
  imagingPlatformFor,
} from '../layers/satellites/sensors.js';
import {
  IMAGERY_SLOTS,
  IMAGERY_SLOT_ORDER,
} from '../layers/imageryOverlays/catalog.js';

test('the head line says the orbit and the swath, or that the imager sees a disk', () => {
  assert.equal(orbitText(imagingPlatformFor(43013)), 'POLAR ORBIT · 3,060 km SWATH');
  assert.equal(orbitText(imagingPlatformFor(60133)), 'GEOSTATIONARY · FULL DISK');
  assert.equal(orbitText(null), '');
});

test('currency never lets a published product pass as live', () => {
  // The closest thing here to live is a geostationary frame ten minutes old;
  // everything says so, and a daily mosaic says it is a day behind.
  for (const slotId of IMAGERY_SLOT_ORDER) {
    for (const product of IMAGERY_SLOTS[slotId].products) {
      const text = currencyText(product);
      assert.match(text, /not a live view/, `${product.key}: ${text}`);
    }
  }
  assert.match(currencyText({ cadence: 'rolling' }), /~10 min/);
  assert.match(currencyText({ cadence: 'daily', lagDays: 1 }), /1 day behind/);
  assert.equal(currencyText(null), '');
});

test('every platform with a product gets its buttons in slot order, and only its own', () => {
  let offered = 0;
  for (const platform of IMAGING_PLATFORMS) {
    const products = productsForPlatform(platform);
    offered += products.length;
    const wanted = new Set(platform.platforms);
    let lastSlot = -1;
    for (const { slotId, product } of products) {
      assert.ok(wanted.has(product.platform), `${platform.name} got ${product.key}`);
      const slotIndex = IMAGERY_SLOT_ORDER.indexOf(slotId);
      assert.ok(slotIndex >= lastSlot, `${platform.name}: ${slotId} out of order`);
      lastSlot = slotIndex;
    }
  }
  assert.ok(offered >= 20, `only ${offered} products offered across the fleet`);
  // NOAA-20 has the VIIRS products and nothing from another satellite.
  const n20 = productsForPlatform(imagingPlatformFor(43013)).map((p) => p.product.key);
  assert.ok(n20.some((k) => k.startsWith('viirs-n20')), n20.join(','));
  assert.ok(!n20.some((k) => k.includes('snpp')), n20.join(','));
  assert.deepEqual(productsForPlatform(null), []);
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
    // Setting textContent on a real element drops its children; the panel
    // clears its body that way, so the double must too.
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

/** Every element under `root`, depth first. */
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

/** A window double that records listeners and can fire the awareness events. */
function fakeWindow() {
  const listeners = {};
  return {
    addEventListener(type, fn, options) {
      (listeners[type] ||= []).push(fn);
      options?.signal?.addEventListener('abort', () => {
        listeners[type] = listeners[type].filter((x) => x !== fn);
      });
    },
    fire(type, detail) {
      (listeners[type] || []).forEach((fn) => fn({ detail }));
    },
  };
}

function fakeSatellites(present, tracked = []) {
  return {
    hasSatellite: (norad) => present.includes(Number(norad)),
    satelliteName: (norad) => `SAT ${norad}`,
    trackSatellite: (norad) => tracked.push(Number(norad)),
    getTrackedNorad: () => null,
  };
}

function panelWith(options = {}) {
  const elements = {
    state: makeElement('span'),
    body: makeElement('div'),
    note: makeElement('p'),
  };
  const selected = [];
  const toggled = [];
  const active = new Map();
  const windowRef = fakeWindow();
  const expanded = [];
  const panel = new SensorsPanel({
    elements,
    satellites: () => options.satellites || null,
    selectSensor: async (slotId, key) => {
      selected.push([slotId, key]);
      active.set(slotId, key);
    },
    activeSensor: (slotId) => active.get(slotId) ?? null,
    isProductAvailable: options.isProductAvailable,
    setLayerEnabled: async (id, on) => toggled.push([id, on]),
    isLayerEnabled: (id) => toggled.some(([x, on]) => x === id && on),
    openIssStream: options.openIssStream,
    expandPanel: (id) => expanded.push(id),
    windowRef,
  });
  return { panel, elements, selected, toggled, active, windowRef, expanded };
}

test('with nothing tracked, the imaging fleet on the globe is listed with TRACK buttons', async () => {
  await withFakeDom(() => {
    const tracked = [];
    const sats = fakeSatellites([43013, 60133, 25544, 12345], tracked);
    const { panel, elements } = panelWith({ satellites: sats });
    panel.connect();
    assert.equal(elements.state.textContent, 'NONE');
    const rows = findAll(elements.body, 'sensors-fleet-row');
    assert.deepEqual(
      rows.map((r) => r.dataset.norad),
      ['43013', '60133', '25544'],
      'only imaging platforms in the loaded catalog, in registry order',
    );
    rows[0].click();
    assert.deepEqual(tracked, [43013]);
    assert.match(elements.note.textContent, /Track an imaging satellite/);
    panel.destroy();
  });
});

test('with the satellites layer off, the panel says how to get the fleet', async () => {
  await withFakeDom(() => {
    const { panel, elements } = panelWith({ satellites: null });
    panel.connect();
    assert.equal(findAll(elements.body, 'sensors-fleet-row').length, 0);
    assert.match(findAll(elements.body, 'sensors-empty')[0].textContent, /Turn on Satellites/);
    panel.destroy();
  });
});

test('tracking an imaging satellite shows its instruments and every band the globe can draw', async () => {
  await withFakeDom(async () => {
    const sats = fakeSatellites([43013]);
    const { panel, elements, selected, windowRef, expanded } = panelWith({
      satellites: sats,
    });
    panel.connect();
    windowRef.fire('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: '43013',
    });
    assert.equal(elements.state.textContent, 'NOAA-20');
    assert.deepEqual(expanded, ['sensors-panel'], 'the panel opens itself');
    assert.equal(findAll(elements.body, 'sensors-instrument').length, 1);
    assert.match(
      findAll(elements.body, 'sensors-instrument-facts')[0].textContent,
      /3,060 km swath/,
    );
    const buttons = findAll(elements.body, 'imagery-sensor');
    assert.ok(buttons.length >= 2, 'VIIRS bands offered');
    assert.ok(buttons.every((b) => b.dataset['attr_aria-pressed'] === 'false'));
    // The footer must not pretend a picture is live before one is chosen.
    assert.match(elements.note.textContent, /Nothing here commands the spacecraft/);

    buttons[0].click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(selected.length, 1);
    assert.equal(selected[0][1], buttons[0].dataset.key);
    const after = findAll(elements.body, 'imagery-sensor');
    const pressed = after.filter((b) => b.className.includes('active'));
    assert.equal(pressed.length, 1);
    assert.equal(pressed[0].dataset.key, buttons[0].dataset.key);
    assert.match(elements.note.textContent, /not a live view/);
    panel.destroy();
  });
});

test('a keyed product stays off the panel until its credentials exist', async () => {
  await withFakeDom(() => {
    const sats = fakeSatellites([40697]);
    const { panel, elements, windowRef } = panelWith({
      satellites: sats,
      isProductAvailable: (product) => !product.requiresKey,
    });
    panel.connect();
    windowRef.fire('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: 40697,
    });
    assert.equal(elements.state.textContent, 'SENTINEL-2A');
    // Sentinel-2 is served through Copernicus credentials only, so with none
    // configured the platform says its bands are waiting on a key rather than
    // offering buttons that would fail.
    assert.equal(findAll(elements.body, 'imagery-sensor').length, 0);
    assert.match(
      findAll(elements.body, 'sensors-empty')[0].textContent,
      /need a key/i,
    );
    panel.destroy();
  });
});

test('tracking a satellite with no imager says so, and clearing returns to the fleet', async () => {
  await withFakeDom(() => {
    const sats = fakeSatellites([43013, 12345]);
    const { panel, elements, windowRef, expanded } = panelWith({ satellites: sats });
    panel.connect();
    windowRef.fire('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: 12345,
    });
    assert.equal(elements.state.textContent, 'NO SENSOR');
    assert.deepEqual(expanded, [], 'a bare dot does not pop the panel open');
    assert.match(findAll(elements.body, 'sensors-empty')[0].textContent, /SAT 12345 carries no imaging sensor/);
    assert.equal(findAll(elements.body, 'sensors-fleet-row').length, 1);
    // A selection on another layer is not this panel's business.
    windowRef.fire('gev:awareness-subject-selected', { layerId: 'flights', id: 'abc' });
    assert.equal(elements.state.textContent, 'NO SENSOR');
    windowRef.fire('gev:awareness-subject-cleared', { layerId: 'satellites' });
    assert.equal(elements.state.textContent, 'NONE');
    panel.destroy();
  });
});

test('the station offers the live stream and the lightning mapper offers its data layer', async () => {
  await withFakeDom(async () => {
    let opened = 0;
    const sats = fakeSatellites([25544, 60133]);
    const { panel, elements, windowRef, toggled } = panelWith({
      satellites: sats,
      openIssStream: () => opened++,
    });
    panel.connect();
    windowRef.fire('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: 25544,
    });
    const stream = findAll(elements.body, 'imagery-sensor').find((b) =>
      findAll(b, 'imagery-sensor-label').some((l) => l.textContent === 'ISS LIVE STREAM'),
    );
    assert.ok(stream, 'the station gets its stream button');
    stream.click();
    assert.equal(opened, 1);

    windowRef.fire('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: 60133,
    });
    assert.equal(elements.state.textContent, 'GOES-19 (EAST)');
    const glm = findAll(elements.body, 'imagery-sensor').find((b) =>
      findAll(b, 'imagery-sensor-reveals').some((l) => /data layer, not imagery/.test(l.textContent)),
    );
    assert.ok(glm, 'the lightning mapper offers its layer');
    glm.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(toggled, [['lightning', true]]);
    panel.destroy();
  });
});

test('a destroyed panel stops listening', async () => {
  await withFakeDom(() => {
    const sats = fakeSatellites([43013]);
    const { panel, elements, windowRef } = panelWith({ satellites: sats });
    panel.connect();
    panel.destroy();
    windowRef.fire('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: 43013,
    });
    assert.equal(elements.state.textContent, 'NONE');
  });
});

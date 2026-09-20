import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SensorsPanel,
  currencyText,
  imagingText,
  loopClockText,
  observerText,
  orbitText,
  overheadText,
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
  const windowRef = options.windowRef || fakeWindow();
  const expanded = [];
  const toasts = [];
  const panel = new SensorsPanel({
    elements,
    satellites: () => options.satellites || null,
    onToast: (m) => toasts.push(m),
    frameLoop: options.frameLoop || null,
    passes: options.passes || null,
    viewCenter: options.viewCenter || null,
    geolocate: options.geolocate || null,
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
  return {
    panel,
    elements,
    selected,
    toggled,
    active,
    windowRef,
    expanded,
    toasts,
  };
}

test('a band picked here becomes the one on the globe: the other slots are set aside', async () => {
  // The slots stack. A science ramp drawn over the picked product hides it
  // completely, and "I clicked a band and nothing changed" was exactly that.
  await withFakeDom(async () => {
    const sats = fakeSatellites([43013]);
    const { panel, elements, selected, toggled, windowRef, toasts } =
      panelWith({ satellites: sats });
    // Science and radar are on before the pick.
    toggled.push(['imagery-science', true], ['imagery-radar', true]);
    panel.connect();
    windowRef.fire('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: 43013,
    });
    const buttons = findAll(elements.body, 'imagery-sensor');
    buttons[0].click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(
      toggled.slice(2),
      [
        ['imagery-science', false],
        ['imagery-radar', false],
      ],
      'the slots above the picked one are turned off first',
    );
    assert.equal(selected[0][0], 'imagery-viirs');
    assert.match(toasts.at(-1), /2 other imagery overlays set aside/);
    assert.match(toasts.at(-1), /IMAGERY brings them back/);
    panel.destroy();
  });
});

test('with nothing tracked, the imaging fleet on the globe is listed with TRACK buttons', async () => {
  await withFakeDom(() => {
    const tracked = [];
    const sats = fakeSatellites([43013, 60133, 25544, 12345], tracked);
    const { panel, elements } = panelWith({ satellites: sats });
    panel.connect();
    assert.equal(elements.state.textContent, 'READY');
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
    const { panel, elements, selected, windowRef, expanded, toasts } =
      panelWith({
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
    assert.equal(toasts.length, 0, 'nothing else was on: nothing set aside');
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
    assert.equal(elements.state.textContent, 'READY');
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
    assert.equal(elements.state.textContent, 'READY');
  });
});

test('a geostationary imager with a band showing offers its frames as a loop', async () => {
  await withFakeDom(async () => {
    let loop = null;
    const calls = [];
    const frameLoop = {
      canLoop: (slotId) => slotId === 'imagery-goes',
      windowText: () => 'the last 2 h',
      start: async (slotId) => {
        calls.push(`start:${slotId}`);
        loop = { playing: true, frames: 12, index: 6, instant: '2026-09-19T19:50:00Z' };
        return { frames: 12 };
      },
      stop: async (slotId) => {
        calls.push(`stop:${slotId}`);
        loop = null;
        return true;
      },
      state: () => loop,
    };
    const timers = [];
    const windowRef = fakeWindow();
    windowRef.setInterval = (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    };
    windowRef.clearInterval = (id) => {
      timers[id - 1] = null;
    };
    const sats = fakeSatellites([60133]);
    const { panel, elements, active } = panelWith({ satellites: sats, frameLoop, windowRef });
    panel.connect();
    windowRef.fire('gev:awareness-subject-selected', { layerId: 'satellites', id: 60133 });
    // No band showing yet: nothing to loop.
    assert.equal(findAll(elements.body, 'imagery-sensor').filter((b) => b.dataset.loop).length, 0);
    // Pick GeoColor, and the loop is offered for that slot.
    active.set('imagery-goes', 'goes-east-geo');
    panel.render();
    const play = findAll(elements.body, 'imagery-sensor').find((b) => b.dataset.loop);
    assert.ok(play, 'the loop button appears once a band shows');
    assert.equal(play.dataset.loop, 'imagery-goes');
    assert.equal(findAll(play, 'imagery-sensor-label')[0].textContent, 'PLAY THE LAST 2 H');
    play.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['start:imagery-goes']);
    const stop = findAll(elements.body, 'imagery-sensor').find((b) => b.dataset.loop);
    assert.equal(findAll(stop, 'imagery-sensor-label')[0].textContent, '19:50Z · 7 / 12 · STOP');
    assert.equal(timers.filter(Boolean).length, 1, 'a ticker follows the frame');
    loop = { ...loop, index: 7, instant: '2026-09-19T20:00:00Z' };
    timers[0].fn();
    assert.equal(findAll(stop, 'imagery-sensor-label')[0].textContent, '20:00Z · 8 / 12 · STOP');
    stop.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['start:imagery-goes', 'stop:imagery-goes']);
    assert.equal(timers.filter(Boolean).length, 0, 'ticker cleared with the loop');
    assert.equal(loopClockText(null), '');
    panel.destroy();
  });
});

test('a loop that cannot start says so instead of doing nothing', async () => {
  await withFakeDom(async () => {
    const frameLoop = {
      canLoop: () => true,
      windowText: () => 'the last 36 h',
      start: async () => null,
      stop: async () => false,
      state: () => null,
    };
    const sats = fakeSatellites([60133]);
    const { panel, elements, active, windowRef, toasts } = panelWith({ satellites: sats, frameLoop });
    panel.connect();
    windowRef.fire('gev:awareness-subject-selected', { layerId: 'satellites', id: 60133 });
    active.set('imagery-goes', 'georing-natural');
    panel.render();
    findAll(elements.body, 'imagery-sensor').find((b) => b.dataset.loop).click();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(toasts.at(-1), /fewer than two/);
    panel.destroy();
  });
});

const NOW = Date.parse('2026-09-19T12:00:00Z');

test('pass text says when, how high, from where, and what the picture will be worth', () => {
  assert.equal(observerText({ lat: 28.61, lon: -80.6 }), '28.6°N 80.6°W');
  assert.equal(observerText({ lat: -33.9, lon: 151.2 }), '33.9°S 151.2°E');
  assert.equal(observerText(null), '');
  assert.equal(
    overheadText(
      { status: 'ok', pass: { riseMs: NOW + 72 * 60_000, maxElevDeg: 53.6, riseAzDeg: 230 } },
      NOW,
    ),
    '13:12Z (in 1 h 12 min) · max 54° · rises SW',
  );
  assert.equal(overheadText({ status: 'none' }, NOW), 'no pass above 10° in the next 24 h');
  assert.equal(overheadText({ status: 'no-tle' }, NOW), 'no elements for this satellite yet');
  assert.equal(overheadText(null, NOW), '');
  const product = { cadence: 'daily', lagDays: 1 };
  assert.equal(
    imagingText(
      { status: 'ok', pass: { atMs: NOW + 75 * 60_000, offTrackKm: 380, daylight: true } },
      NOW,
      product,
    ),
    '13:15Z (in 1 h 15 min) · 380 km off track · in daylight; the picture publishes 1 day behind',
  );
  assert.match(
    imagingText({ status: 'ok', pass: { atMs: NOW + 60_000, offTrackKm: 12, daylight: false } }, NOW, null),
    /near nadir.*at night — a visible band records nothing/,
  );
  assert.match(imagingText({ status: 'geostationary' }, NOW), /always in view/);
  assert.equal(imagingText({ status: 'not-imager' }, NOW), '');
  assert.match(imagingText({ status: 'none' }, NOW), /does not cover/);
});

test('passes are predicted for the ground the user was looking at when tracking began', async () => {
  await withFakeDom(async () => {
    const asked = [];
    let center = { lat: 30.27, lon: -97.74 };
    const passes = {
      overhead: (norad, q) => {
        asked.push(['overhead', norad, q.latDeg, q.lonDeg]);
        return { status: 'ok', pass: { riseMs: Date.now() + 3600_000, maxElevDeg: 40, riseAzDeg: 180 } };
      },
      imaging: (norad, q) => {
        asked.push(['imaging', norad, q.latDeg, q.lonDeg]);
        return { status: 'ok', pass: { atMs: Date.now() + 3900_000, offTrackKm: 200, daylight: true } };
      },
    };
    const sats = fakeSatellites([43013]);
    const { panel, elements, windowRef } = panelWith({
      satellites: sats,
      passes,
      viewCenter: () => center,
      geolocate: async () => ({ lat: 51.5, lon: -0.12 }),
    });
    panel.connect();
    // The camera moves to the satellite once tracking starts; the observer
    // must be the ground from BEFORE that, not the satellite's.
    windowRef.fire('gev:awareness-subject-selected', { layerId: 'satellites', id: 43013 });
    center = { lat: -40, lon: 100 };
    panel.render();
    assert.equal(asked[0][2], 30.27, 'predicted for the pre-tracking view');
    const keys = findAll(elements.body, 'sensors-pass-key').map((k) => k.textContent);
    assert.deepEqual(keys, ['NEXT OVERHEAD', 'IMAGES THIS GROUND']);
    const heading = findAll(elements.body, 'sensors-fleet-heading').map((h) => h.textContent);
    assert.ok(heading.some((h) => h.startsWith('PASSES OVER 30.3°N 97.7°W')), heading.join('|'));
    const values = findAll(elements.body, 'sensors-pass-value').map((v) => v.textContent);
    assert.match(values[0], /max 40° · rises S/);
    assert.match(values[1], /200 km off track · in daylight/);
    // Predictions are cached: re-rendering does not recompute.
    const before = asked.length;
    panel.render();
    assert.equal(asked.length, before);
    // USE THE VIEW takes the current screen centre.
    findAll(elements.body, 'sensors-pass-btn').find((b) => b.textContent === 'USE THE VIEW').click();
    assert.equal(asked.at(-1)[2], -40);
    // MY LOCATION asks the device, only when pressed.
    findAll(elements.body, 'sensors-pass-btn').find((b) => b.textContent === 'MY LOCATION').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(asked.at(-1)[2], 51.5);
    assert.ok(
      findAll(elements.body, 'sensors-fleet-heading').some((h) => /YOUR LOCATION/.test(h.textContent)),
    );
    panel.destroy();
  });
});

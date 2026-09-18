import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ImageryPanel,
  archiveText,
  cadenceText,
  coverageText,
} from './imageryPanel.js';
import {
  ALL_IMAGERY_PRODUCTS as ALL,
  IMAGERY_SLOTS,
  IMAGERY_SLOT_ORDER,
  productFor,
} from '../layers/imageryOverlays/catalog.js';

test('cadence is stated as the vintage it actually is', () => {
  assert.equal(cadenceText({ cadence: 'rolling' }), 'refreshed ~10 min');
  assert.equal(cadenceText({ cadence: 'static' }), 'fixed composite');
  assert.equal(cadenceText({ cadence: 'daily', lagDays: 1 }), '1 day behind');
  assert.equal(cadenceText({ cadence: 'daily', lagDays: 3 }), '3 days behind');
  assert.equal(cadenceText({ cadence: 'daily', lagDays: 0 }), 'same day');
  // A daily product with no measured lag must not silently claim to be current.
  assert.equal(cadenceText({ cadence: 'daily' }), '1 day behind');
  assert.equal(cadenceText(null), '');
});

test('archive text names the year, and stays silent when there is no archive', () => {
  assert.equal(archiveText({ archive: '2000-02-24' }), 'archive to 2000');
  assert.equal(archiveText({ archive: null }), '');
  assert.equal(archiveText(null), '');
});

test('a swath product says its coverage is partial', () => {
  // Turning on a swath product leaves most of the globe empty. Unless the
  // panel says so, that reads as a failed load rather than as the instrument
  // imaging strips, which is what it actually does.
  assert.equal(coverageText({ sparse: true }), 'partial coverage');
  assert.equal(coverageText({ sparse: false }), '');
  assert.equal(coverageText(null), '');
  const sparse = ALL.filter((p) => p.sparse).map((p) => p.key);
  assert.ok(sparse.includes('opera-sar'), 'Sentinel-1 SAR images in swaths');
  assert.ok(sparse.includes('flood-extent'));
});

test('every product renders a non-empty, non-duplicated description line', () => {
  const seen = new Set();
  for (const slotId of IMAGERY_SLOT_ORDER) {
    for (const p of IMAGERY_SLOTS[slotId].products) {
      assert.ok(cadenceText(p).length, `${p.key} has no cadence text`);
      assert.ok(
        !seen.has(p.reveals),
        `${p.key} repeats another product's description verbatim`,
      );
      seen.add(p.reveals);
    }
  }
});

/* ------------------------------------------------------------------ *
 * DOM double — enough of an element to exercise render and clicks.
 * ------------------------------------------------------------------ */

function makeElement(tag) {
  const node = {
    tagName: tag,
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    disabled: false,
    _listeners: {},
    classList: {
      _set: new Set(),
      add(...c) {
        c.forEach((x) => this._set.add(x));
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    setAttribute(k, v) {
      node.dataset[`attr_${k}`] = v;
    },
    append(...kids) {
      node.children.push(...kids);
    },
    replaceChildren(...kids) {
      node.children = [...kids];
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

/**
 * Install the DOM double for the duration of `run`, including when `run` is
 * async — a synchronous `finally` would restore the real (undefined) document
 * the moment the promise was returned, and every render after the first await
 * would explode.
 */
async function withFakeDom(run) {
  const prior = globalThis.document;
  globalThis.document = { createElement: (tag) => makeElement(tag) };
  try {
    return await run();
  } finally {
    globalThis.document = prior;
  }
}

/** A data manager whose imagery slots behave like the real layer modules. */
function fakeManager() {
  const enabled = new Set();
  const selection = new Map();
  const listeners = [];
  for (const slotId of IMAGERY_SLOT_ORDER)
    selection.set(slotId, IMAGERY_SLOTS[slotId].defaultKey);
  const layers = new Map();
  for (const slotId of IMAGERY_SLOT_ORDER) {
    layers.set(slotId, {
      module: {
        listSensors: () => IMAGERY_SLOTS[slotId].products,
        getSlot: () => ({ id: slotId, ...IMAGERY_SLOTS[slotId] }),
        getSensor: () => selection.get(slotId),
        getSensorProduct: () => productFor(slotId, selection.get(slotId)),
        setSensor: async (key) => {
          const next = productFor(slotId, key);
          if (!next || next.key === selection.get(slotId)) return false;
          selection.set(slotId, next.key);
          return true;
        },
      },
    });
  }
  layers.set('imagery-radar', { module: {} });
  return {
    layers,
    enabled,
    isEnabled: (id) => enabled.has(id),
    setEnabled: async (id, on) => {
      if (on) enabled.add(id);
      else enabled.delete(id);
      listeners.forEach((fn) => fn({ type: 'status' }));
    },
    subscribeActivity: (fn) => {
      listeners.push(fn);
      return () => {};
    },
  };
}

function panelWith(dm, toasts = []) {
  const elements = {
    list: makeElement('div'),
    layerState: makeElement('span'),
    clearBtn: makeElement('button'),
    note: makeElement('p'),
  };
  const panel = new ImageryPanel({
    elements,
    dataManager: dm,
    onToast: (m) => toasts.push(m),
  });
  return { panel, elements, toasts };
}

test('the panel renders one group per slot and reads CLEAR when nothing covers the globe', async () => {
  await withFakeDom(() => {
    const dm = fakeManager();
    const { panel, elements } = panelWith(dm);
    panel.connect();
    assert.equal(elements.list.children.length, IMAGERY_SLOT_ORDER.length);
    assert.equal(elements.layerState.textContent, 'CLEAR');
    assert.equal(elements.clearBtn.disabled, true);
    assert.match(elements.note.textContent, /Nothing is covering the globe/);
    panel.destroy();
  });
});

test('picking a sensor turns its slot on and says so, naming the vintage', async () => {
  await withFakeDom(async () => {
    const dm = fakeManager();
    const { panel, elements, toasts } = panelWith(dm);
    panel.connect();
    await panel.selectSensor('imagery-viirs', 'viirs-n20-night');
    assert.equal(dm.isEnabled('imagery-viirs'), true);
    assert.equal(
      dm.layers.get('imagery-viirs').module.getSensor(),
      'viirs-n20-night',
    );
    assert.equal(elements.layerState.textContent, 'COVERING');
    assert.equal(elements.clearBtn.disabled, false);
    assert.match(toasts.at(-1), /Day\/Night Band/);
    assert.match(toasts.at(-1), /1 day behind/);
    assert.match(
      elements.note.textContent,
      /photorealistic 3D basemap is set aside/,
    );
    panel.destroy();
  });
});

test('when enabling costs the 3D basemap, the toast says so', async () => {
  await withFakeDom(async () => {
    const dm = fakeManager();
    // Imagery cannot draw over Google 3D, so the layer swaps the basemap. The
    // user is losing the photorealistic globe — saying nothing would read as a
    // bug, which is exactly how this was misdiagnosed before.
    dm.layers.get('imagery-goes').module.getSurfaceChange = () => ({
      switched: true,
      from: 'photoreal',
      to: 'esri-imagery',
    });
    const { panel, toasts } = panelWith(dm);
    panel.connect();
    await panel.selectSensor('imagery-goes', 'goes-east-geo');
    assert.match(toasts.at(-1), /Switched to the 2D globe/);
    assert.match(toasts.at(-1), /cannot draw over Google 3D/);
    panel.destroy();
  });
});

test('CLEAR turns every imagery slot off, radar included', async () => {
  await withFakeDom(async () => {
    const dm = fakeManager();
    const { panel, elements, toasts } = panelWith(dm);
    panel.connect();
    await panel.selectSensor('imagery-viirs', 'viirs-n20-true');
    await panel.selectSensor('imagery-goes', 'himawari-ir');
    await dm.setEnabled('imagery-radar', true);
    assert.equal(dm.enabled.size, 3);

    await panel.clearAll();
    assert.equal(dm.enabled.size, 0, 'radar must be cleared too');
    assert.equal(elements.layerState.textContent, 'CLEAR');
    assert.match(toasts.at(-1), /photorealistic globe is back/);
    panel.destroy();
  });
});

test('the panel follows toggles made somewhere else', async () => {
  await withFakeDom(async () => {
    const dm = fakeManager();
    const { panel, elements } = panelWith(dm);
    panel.connect();
    assert.equal(elements.layerState.textContent, 'CLEAR');
    // A combination preset or a restored share link flips the layer directly.
    await dm.setEnabled('imagery-goes', true);
    assert.equal(
      elements.layerState.textContent,
      'COVERING',
      'the panel must not sit reading CLEAR over a covered globe',
    );
    panel.destroy();
  });
});

test('a keyed sensor stays hidden until its credentials exist', async () => {
  await withFakeDom(async () => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ json: async () => ({ ready: false }) });
    try {
      const dm = fakeManager();
      const { panel, elements } = panelWith(dm);
      panel.connect();
      await new Promise((r) => setTimeout(r, 0));
      panel.render();
      const rendered = elements.list.children
        .flatMap((slot) => slot.children)
        .flatMap((node) => node.children || [])
        .map((b) => b.dataset?.sensor)
        .filter(Boolean);
      assert.ok(
        !rendered.includes('sentinel2-true'),
        'offering a control that cannot work is worse than not offering it',
      );
      panel.destroy();
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});

test('a keyed sensor appears once its credentials are configured', async () => {
  await withFakeDom(async () => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ json: async () => ({ ready: true }) });
    try {
      const dm = fakeManager();
      const { panel, elements } = panelWith(dm);
      panel.connect();
      await new Promise((r) => setTimeout(r, 0));
      panel.render();
      const rendered = elements.list.children
        .flatMap((slot) => slot.children)
        .flatMap((node) => node.children || [])
        .map((b) => b.dataset?.sensor)
        .filter(Boolean);
      assert.ok(rendered.includes('sentinel2-true'));
      panel.destroy();
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});

test('a failed availability check hides the sensor rather than assuming yes', async () => {
  await withFakeDom(async () => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    try {
      const dm = fakeManager();
      const { panel, elements } = panelWith(dm);
      panel.connect();
      await new Promise((r) => setTimeout(r, 0));
      panel.render();
      const rendered = elements.list.children
        .flatMap((slot) => slot.children)
        .flatMap((node) => node.children || [])
        .map((b) => b.dataset?.sensor)
        .filter(Boolean);
      assert.ok(!rendered.includes('sentinel2-true'));
      panel.destroy();
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});

test('a destroyed panel stops responding', async () => {
  await withFakeDom(async () => {
    const dm = fakeManager();
    const { panel, elements } = panelWith(dm);
    panel.connect();
    panel.destroy();
    await panel.selectSensor('imagery-viirs', 'viirs-n20-night');
    assert.equal(dm.isEnabled('imagery-viirs'), false);
    assert.equal(elements.layerState.textContent, 'CLEAR');
  });
});

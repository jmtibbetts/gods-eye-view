import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerSelection, flatRingCentroid } from './layerSelection.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

/** A stand-in for a Cesium ScreenSpaceEventHandler that records its action. */
function fakeHandlerFactory(captured) {
  return () => ({
    setInputAction(fn) {
      captured.click = fn;
    },
    destroy() {
      captured.destroyed = true;
    },
  });
}

function fakeContext(log) {
  return {
    registerEntityContext: (entity, meta) => log.push(['register', meta]),
    selectEntityContext: (entity) => log.push(['select', entity.id]),
    clearSelectedEntityContextForLayer: (layerId) =>
      log.push(['clear', layerId]),
  };
}

/** A viewer whose scene.pick returns whatever the test primes. */
function fakeViewer(pickResult) {
  return {
    scene: {
      canvas: {},
      pick: () => pickResult.value,
    },
  };
}

function build({ pick, records, log = [], captured = {} } = {}) {
  const entities = new Map(
    [...records.keys()].map((id) => [`test:${id}`, { id: `test:${id}` }]),
  );
  const selection = createLayerSelection({
    layerId: 'test-layer',
    layerName: 'Test',
    source: 'Test source',
    entityPrefix: 'test:',
    context: fakeContext(log),
    getRecord: (id) => records.get(id),
    getEntity: (id) => entities.get(`test:${id}`),
    getDataSource: () => ({ name: 'test-layer' }),
    describe: (r) => ({
      label: `Record ${r.id}`,
      latitude: r.lat,
      longitude: r.lon,
      properties: { kind: r.kind },
    }),
    screenSpaceEventHandlerFactory: fakeHandlerFactory(captured),
  });
  return { selection, log, captured, pick };
}

const RECORDS = new Map([
  ['a', { id: 'a', lat: 10, lon: 20, kind: 'x' }],
  ['b', { id: 'b', lat: 30, lon: 40, kind: 'y' }],
]);

test('clicking one of the layer entities selects it and publishes a readout', () => {
  const pick = { value: { id: { id: 'test:a' } } };
  const { selection, log, captured } = build({ pick, records: RECORDS });
  selection.install(fakeViewer(pick));
  captured.click({ position: { x: 0, y: 0 } });
  assert.equal(selection.selectedId(), 'a');
  const registered = log.find(([k]) => k === 'register')?.[1];
  assert.equal(registered.layerId, 'test-layer');
  assert.equal(registered.label, 'Record a');
  assert.equal(registered.latitude, 10);
  assert.equal(registered.longitude, 20);
  assert.deepEqual(registered.properties, { kind: 'x' });
  assert.ok(log.some(([k, v]) => k === 'select' && v === 'test:a'));
});

test('clicking empty space clears an existing selection', () => {
  const pick = { value: { id: { id: 'test:a' } } };
  const { selection, log, captured } = build({ pick, records: RECORDS });
  selection.install(fakeViewer(pick));
  captured.click({ position: {} });
  assert.equal(selection.selectedId(), 'a');
  pick.value = undefined;
  captured.click({ position: {} });
  assert.equal(selection.selectedId(), null);
  assert.ok(log.some(([k, v]) => k === 'clear' && v === 'test-layer'));
});

test("clicking another layer's entity does not clear this layer's selection", () => {
  // The whole point of pick ownership: two layers each listening to every
  // click must not fight over the readout.
  registerPickOwner(
    'other-layer',
    (id) => typeof id === 'string' && id.startsWith('other:'),
  );
  try {
    const pick = { value: { id: { id: 'test:a' } } };
    const { selection, captured } = build({ pick, records: RECORDS });
    selection.install(fakeViewer(pick));
    captured.click({ position: {} });
    pick.value = { id: { id: 'other:z' } };
    captured.click({ position: {} });
    assert.equal(
      selection.selectedId(),
      'a',
      "another layer's click must not clear",
    );
  } finally {
    unregisterPickOwner('other-layer');
  }
});

test('a click on a prefixed id with no record behind it does not select', () => {
  const pick = { value: { id: { id: 'test:missing' } } };
  const { selection, captured, log } = build({ pick, records: RECORDS });
  selection.install(fakeViewer(pick));
  captured.click({ position: {} });
  assert.equal(selection.selectedId(), null);
  assert.equal(log.length, 0);
});

test('install is idempotent and remove tears everything down', () => {
  const pick = { value: undefined };
  const { selection, captured } = build({ pick, records: RECORDS });
  const viewer = fakeViewer(pick);
  selection.install(viewer);
  const first = captured.click;
  selection.install(viewer);
  assert.equal(
    captured.click,
    first,
    'a second install must not stack handlers',
  );
  selection.remove();
  assert.equal(captured.destroyed, true);
});

test('install without a usable viewer is a no-op, so headless tests can enable()', () => {
  const { selection, captured } = build({
    pick: { value: undefined },
    records: RECORDS,
  });
  selection.install(undefined);
  selection.install({});
  selection.install({ scene: {} });
  assert.equal(captured.click, undefined);
});

test('reconcile drops a selection whose record has gone', () => {
  const records = new Map(RECORDS);
  const pick = { value: { id: { id: 'test:a' } } };
  const { selection, captured, log } = build({ pick, records });
  selection.install(fakeViewer(pick));
  captured.click({ position: {} });
  assert.equal(selection.selectedId(), 'a');
  selection.reconcile();
  assert.equal(selection.selectedId(), 'a', 'still present, still selected');
  records.delete('a');
  selection.reconcile();
  assert.equal(selection.selectedId(), null);
  assert.ok(log.some(([k]) => k === 'clear'));
});

test('select without a context store reports false and leaves nothing selected', () => {
  const selection = createLayerSelection({
    layerId: 'x',
    layerName: 'X',
    source: 'S',
    entityPrefix: 'x:',
    context: null,
    getRecord: (id) => RECORDS.get(id),
    getEntity: () => ({}),
    getDataSource: () => null,
    describe: () => ({ label: '', latitude: 0, longitude: 0 }),
  });
  assert.equal(selection.select('a'), false);
  assert.equal(selection.selectedId(), null);
});

test('a flat ring centroid is the mean of its vertices', () => {
  assert.deepEqual(flatRingCentroid([0, 0, 10, 0, 10, 10, 0, 10]), {
    lon: 5,
    lat: 5,
  });
  assert.equal(flatRingCentroid([0, 0, 1, 1]), null);
  assert.equal(flatRingCentroid(null), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageryDrape,
  drapeExtent,
  drapePixels,
  drapeRequestUrl,
} from './drape.js';

function fakeCesium() {
  return {
    Rectangle: {
      fromDegrees: (west, south, east, north) => ({
        west,
        south,
        east,
        north,
      }),
    },
    ImageMaterialProperty: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    Color: { WHITE: { withAlpha: (alpha) => ({ alpha }) } },
    ClassificationType: { CESIUM_3D_TILE: 1 },
  };
}

function fixture({ loadImage } = {}) {
  const added = [];
  const removed = [];
  const moveEndListeners = new Set();
  let renders = 0;
  const viewer = {
    entities: {
      add(options) {
        added.push(options);
        return options;
      },
      remove(entity) {
        removed.push(entity);
        return true;
      },
    },
    camera: {
      computeViewRectangle: () => ({
        west: -0.2,
        south: 0.6,
        east: -0.1,
        north: 0.7,
      }),
      moveEnd: {
        addEventListener(listener) {
          moveEndListeners.add(listener);
          return () => moveEndListeners.delete(listener);
        },
      },
    },
    scene: {
      globe: { ellipsoid: {} },
      canvas: { clientWidth: 1600, clientHeight: 900 },
      requestRender: () => {
        renders++;
      },
    },
  };
  const requested = [];
  const drape = createImageryDrape({
    viewer,
    id: 'imagery-goes',
    cesium: fakeCesium(),
    loadImage:
      loadImage ||
      ((url) => {
        requested.push(url);
        return Promise.resolve({});
      }),
  });
  const source = {
    url: 'https://example.test/wms',
    layers: 'GOES_East',
    parameters: { TIME: '2026-09-18' },
  };
  const moveCamera = () => {
    for (const listener of moveEndListeners) listener();
  };
  return {
    drape,
    viewer,
    added,
    removed,
    requested,
    source,
    moveCamera,
    moveEndListeners,
    renders: () => renders,
  };
}

test('an extent is padded past the view, so a small pan shows no seam', () => {
  const extent = drapeExtent({ west: -10, south: 40, east: -6, north: 44 });
  assert.ok(extent.west < -10 && extent.east > -6);
  assert.ok(extent.south < 40 && extent.north > 44);
});

test('an extent never leaves the coordinates a map can express', () => {
  const extent = drapeExtent({ west: -179, south: -89, east: 179, north: 89 });
  assert.ok(extent.west >= -180 && extent.east <= 180);
  assert.ok(extent.south >= -90 && extent.north <= 90);
});

test('a view that wraps the antimeridian asks for the whole width', () => {
  // west greater than east is Cesium saying the view crosses 180°, which no
  // single box can express; the planet is the honest answer at that zoom.
  const extent = drapeExtent({ west: 170, south: -20, east: -170, north: 20 });
  assert.equal(extent.west, -180);
  assert.equal(extent.east, 180);
});

test('pixels follow the shape of the box and stop at the size of the window', () => {
  const wide = drapePixels({ west: -20, east: 20, south: 0, north: 10 }, 1600);
  assert.equal(wide.width, 1600);
  assert.equal(wide.height, 400);
  const tall = drapePixels({ west: 0, east: 10, south: -20, north: 20 }, 1600);
  assert.equal(tall.height, 1600);
  assert.equal(tall.width, 400);
});

test('a sliver of a box still asks for a usable picture', () => {
  const sliver = drapePixels(
    { west: -60, east: 60, south: 0, north: 0.01 },
    1600,
  );
  assert.ok(sliver.height >= 256, 'a one-pixel-tall request is not a picture');
});

test('a request names the box latitude first, as WMS 1.3.0 reads it', () => {
  const url = drapeRequestUrl(
    { url: 'https://example.test/wms', layers: 'X', parameters: { TIME: 'D' } },
    { west: -10, south: 40, east: -6, north: 44 },
    { width: 800, height: 800 },
  );
  const query = new URL(url).searchParams;
  assert.equal(query.get('BBOX'), '40,-10,44,-6');
  assert.equal(query.get('CRS'), 'EPSG:4326');
  assert.equal(query.get('VERSION'), '1.3.0');
  assert.equal(query.get('LAYERS'), 'X');
  assert.equal(query.get('TIME'), 'D');
});

test('a source that already carries a query keeps it', () => {
  const url = drapeRequestUrl(
    { url: 'https://example.test/wms?token=abc', layers: 'X' },
    { west: -1, south: 1, east: 1, north: 2 },
    { width: 256, height: 256 },
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('token'), 'abc');
  assert.equal(parsed.searchParams.get('REQUEST'), 'GetMap');
});

test('showing a product drapes it onto the 3D surface, not the globe', async () => {
  const f = fixture();
  assert.equal(await f.drape.show(f.source, { alpha: 0.8 }), true);
  assert.equal(f.added.length, 1);
  const rectangle = f.added[0].rectangle;
  assert.equal(rectangle.classificationType, 1, 'draped onto rendered tiles');
  assert.equal(rectangle.material.color.alpha, 0.8);
  assert.ok(f.drape.isShowing());
});

test('the old picture stays up until the new one has decoded', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = fixture({
    loadImage: () => (++calls === 1 ? Promise.resolve({}) : gate),
  });
  await f.drape.show(f.source);
  assert.equal(f.added.length, 1);
  const pending = f.drape.refresh();
  assert.equal(f.removed.length, 0, 'nothing is taken down while in flight');
  assert.ok(f.drape.isShowing(), 'the surface is never left bare mid-pan');
  release({});
  await pending;
  assert.equal(f.added.length, 2);
  assert.equal(f.removed.length, 1, 'and only then is the old one dropped');
});

test('settling the camera somewhere else asks for that somewhere else', async () => {
  const f = fixture();
  await f.drape.show(f.source);
  const first = f.requested.length;
  f.moveCamera();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requested.length, first + 1);
});

test('a superseded request cannot paint over a newer one', async () => {
  const gates = [];
  const f = fixture({
    loadImage: () =>
      new Promise((resolve) => {
        gates.push(resolve);
      }),
  });
  const first = f.drape.show(f.source);
  const second = f.drape.refresh();
  gates[1]({});
  await second;
  gates[0]({});
  assert.equal(await first, false, 'the stale one reports that it lost');
  assert.equal(f.added.length, 1, 'and never reaches the surface');
});

test('a picture that cannot be fetched is reported, not drawn blank', async () => {
  const f = fixture({
    loadImage: () => Promise.reject(new Error('502 from the service')),
  });
  assert.equal(await f.drape.show(f.source), false);
  assert.equal(f.added.length, 0, 'an empty rectangle is worse than none');
  assert.match(f.drape.getLastError(), /502/);
});

test('a source naming no layer is not a request worth making', async () => {
  const f = fixture();
  assert.equal(await f.drape.show({ url: 'https://example.test/wms' }), false);
  assert.equal(f.requested.length, 0);
});

test('clearing takes the picture down and stops answering the camera', async () => {
  const f = fixture();
  await f.drape.show(f.source);
  f.drape.clear();
  assert.equal(f.removed.length, 1);
  assert.equal(f.drape.isShowing(), false);
  const before = f.requested.length;
  f.moveCamera();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requested.length, before, 'a cleared drape asks for nothing');
});

test('destruction releases the camera listener and the picture', async () => {
  const f = fixture();
  await f.drape.show(f.source);
  f.drape.destroy();
  assert.equal(f.removed.length, 1);
  assert.equal(f.moveEndListeners.size, 0);
  assert.equal(await f.drape.show(f.source), false, 'and stays down');
});

test('a camera looking away from the planet asks for nothing', async () => {
  const f = fixture();
  f.viewer.camera.computeViewRectangle = () => undefined;
  assert.equal(await f.drape.show(f.source), false);
  assert.equal(f.requested.length, 0);
});

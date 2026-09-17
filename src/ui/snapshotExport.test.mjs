import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drawSnapshot,
  snapshotFilename,
  snapshotStamp,
} from './snapshotExport.js';

const AT = new Date('2026-09-17T14:30:45Z');

test('snapshotStamp builds a title and a coordinate/time meta line', () => {
  const { title, meta } = snapshotStamp({
    caption: 'Las Vegas',
    lat: 36.17,
    lon: -115.14,
    date: AT,
  });
  assert.equal(title, 'Las Vegas');
  assert.match(meta, /36\.170°N 115\.140°W/);
  assert.match(meta, /2026-09-17 14:30Z/);
  assert.match(meta, /GOD.S EYE VIEW$/);
});

test('snapshotStamp falls back to place then to the app name', () => {
  assert.equal(snapshotStamp({ place: 'Sydney' }).title, 'Sydney');
  assert.equal(snapshotStamp({}).title, 'GOD’S EYE VIEW');
});

test('snapshotStamp omits coordinates when they are not finite', () => {
  const { meta } = snapshotStamp({
    caption: 'x',
    lat: null,
    lon: null,
    date: AT,
  });
  assert.equal(meta.includes('°'), false);
  assert.match(meta, /^2026-09-17 14:30Z/);
});

test('snapshotFilename is slugged, dated and .png', () => {
  assert.equal(
    snapshotFilename('Las Vegas, NV!', AT),
    'gods-eye-view-las-vegas-nv-2026-09-17-14-30-45.png',
  );
  assert.equal(
    snapshotFilename('', AT),
    'gods-eye-view-view-2026-09-17-14-30-45.png',
  );
});

test('drawSnapshot composites both canvases and paints the footer text', () => {
  const calls = [];
  const ctx = {
    set fillStyle(v) {
      calls.push(['fillStyle', v]);
    },
    set font(v) {
      calls.push(['font', v]);
    },
    set textBaseline(v) {
      calls.push(['textBaseline', v]);
    },
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    drawImage: (c) => calls.push(['drawImage', c]),
    fillText: (t) => calls.push(['fillText', t]),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  drawSnapshot(ctx, {
    sceneCanvas: 'SCENE',
    overlayCanvas: 'OVERLAY',
    width: 800,
    height: 600,
    stamp: { title: 'Title', meta: 'Meta' },
  });
  const drawn = calls.filter((c) => c[0] === 'drawImage').map((c) => c[1]);
  assert.deepEqual(drawn, ['SCENE', 'OVERLAY']);
  const texts = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.deepEqual(texts, ['Title', 'Meta']);
});

test('drawSnapshot tolerates a missing overlay canvas', () => {
  const drawn = [];
  const ctx = {
    set fillStyle(_v) {},
    set font(_v) {},
    set textBaseline(_v) {},
    fillRect() {},
    drawImage: (c) => drawn.push(c),
    fillText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  drawSnapshot(ctx, {
    sceneCanvas: 'SCENE',
    overlayCanvas: null,
    width: 10,
    height: 10,
    stamp: { title: 't', meta: 'm' },
  });
  assert.deepEqual(drawn, ['SCENE']);
});

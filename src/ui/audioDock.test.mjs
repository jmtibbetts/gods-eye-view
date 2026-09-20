import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioDock, audioDockUrl, frameReferrerPolicy } from './audioDock.js';

test('only plain http(s) pages are framed', () => {
  assert.equal(
    audioDockUrl('http://rx.example:8073/?f=121000amz8'),
    'http://rx.example:8073/?f=121000amz8',
  );
  assert.equal(audioDockUrl('javascript:alert(1)'), null);
  assert.equal(audioDockUrl('http://user:pw@rx.example/'), null);
  assert.equal(audioDockUrl('not a url'), null);
});

function fakeElement() {
  const attrs = new Map();
  const classes = new Set();
  return {
    hidden: true,
    dataset: {},
    style: {},
    textContent: '',
    title: '',
    listeners: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    getBoundingClientRect: () => ({
      left: 20,
      top: 30,
      width: 680,
      height: 440,
    }),
    querySelectorAll: () => [],
  };
}

test('the dock opens, retargets in place, records state and closes to about:blank', () => {
  const elements = {
    root: fakeElement(),
    bar: fakeElement(),
    kind: fakeElement(),
    title: fakeElement(),
    subtitle: fakeElement(),
    note: fakeElement(),
    frame: fakeElement(),
    reloadBtn: fakeElement(),
    zoomBtn: fakeElement(),
    sizeBtn: fakeElement(),
    popoutBtn: fakeElement(),
    closeBtn: fakeElement(),
  };
  const stored = new Map();
  const storage = {
    getItem: (k) => stored.get(k) ?? null,
    setItem: (k, v) => stored.set(k, v),
  };
  const opened = [];
  const dock = new AudioDock({
    elements,
    storage,
    openTab: (url) => opened.push(url),
  });
  const seen = [];
  dock.subscribe((s) => seen.push(s.open));
  assert.equal(dock.open('javascript:alert(1)'), false);
  assert.equal(dock.isOpen(), false);
  assert.equal(
    dock.open('http://rx.example/?f=121000amz8', {
      kind: 'sdr',
      title: 'Westy RX',
      subtitle: '121.000 MHz AM',
      note: 'hello',
    }),
    true,
  );
  assert.equal(elements.root.hidden, false);
  assert.equal(
    elements.frame.getAttribute('src'),
    'http://rx.example/?f=121000amz8',
  );
  assert.equal(elements.title.textContent, 'Westy RX');
  assert.equal(elements.kind.textContent, 'NOW PLAYING');
  assert.equal(
    elements.frame.getAttribute('referrerpolicy'),
    'no-referrer',
    'a receiver is not told where the listener came from',
  );
  assert.equal(elements.note.hidden, false);
  assert.equal(elements.root.dataset.kind, 'sdr');
  dock.open('https://www.liveatc.net/search/?icao=KAUS', {
    kind: 'liveatc',
    title: 'Austin Ground',
  });
  assert.equal(
    elements.frame.getAttribute('src'),
    'https://www.liveatc.net/search/?icao=KAUS',
  );
  assert.equal(elements.kind.textContent, 'NOW PLAYING');
  assert.equal(elements.note.hidden, true, 'no note this time');
  elements.popoutBtn.listeners.click();
  assert.deepEqual(opened, ['https://www.liveatc.net/search/?icao=KAUS']);
  dock.toggleSize();
  assert.equal(dock.getState().size, 'large');
  assert.match(stored.get('gev.audioDock.v1'), /"size":"large"/);
  dock.toggleSize();
  assert.equal(dock.getState().size, 'fit');
  assert.equal(elements.root.style.left, '8px', 'fit hugs the viewport corner');
  dock.toggleSize();
  assert.equal(dock.getState().size, 'normal');
  assert.equal(
    dock.getState().zoom,
    0.8,
    'receiver pages open at 80% by default',
  );
  assert.equal(elements.frame.style.transform, 'scale(0.8)');
  assert.equal(elements.frame.style.width, '125.0000%');
  dock.cycleZoom();
  assert.equal(dock.getState().zoom, 0.65);
  assert.equal(elements.zoomBtn.textContent, '65%');
  assert.equal(dock.setZoom(1), 1);
  assert.equal(elements.frame.style.transform, '');
  assert.match(stored.get('gev.audioDock.v1'), /"zoom":1/);
  dock.close();
  assert.equal(elements.frame.getAttribute('src'), 'about:blank');
  assert.equal(elements.root.hidden, true);
  assert.deepEqual(seen, [false, true, true, false]);
  // A video player is the one page that needs a referrer: YouTube refuses to
  // start an embed without one (player configuration error 153), which is
  // how the ISS stream came up as a dead frame.
  dock.open('https://www.youtube-nocookie.com/embed/awQzjn72bI0', {
    kind: 'video',
    title: 'ISS',
  });
  assert.equal(
    elements.frame.getAttribute('referrerpolicy'),
    'strict-origin-when-cross-origin',
  );
  dock.open('http://rx.example/?f=121000amz8', { kind: 'sdr', title: 'RX' });
  assert.equal(elements.frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(frameReferrerPolicy('video'), 'strict-origin-when-cross-origin');
  assert.equal(frameReferrerPolicy('sdr'), 'no-referrer');
  assert.equal(frameReferrerPolicy(undefined), 'no-referrer');
  dock.destroy();
});

test('the dock names what it is doing, not the software inside it', () => {
  const made = [];
  const element = () => {
    const node = {
      textContent: '',
      hidden: false,
      title: '',
      attrs: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      style: {},
      dataset: {},
      setAttribute(k, v) {
        node.attrs[k] = String(v);
      },
      getAttribute: (k) => node.attrs[k] ?? null,
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({
        width: 680,
        height: 440,
        top: 0,
        left: 0,
      }),
      querySelector: () => null,
    };
    made.push(node);
    return node;
  };
  const root = element();
  const kind = element();
  const zoomBtn = element();
  const dock = new AudioDock({
    elements: { root, kind, zoomBtn, title: element(), subtitle: element() },
  });

  dock.open('https://example.org/stream', { kind: 'video', title: 'ISS LIVE' });
  assert.equal(kind.textContent, 'NOW SHOWING');
  assert.equal(root.getAttribute('aria-label'), 'Now showing');
  assert.doesNotMatch(zoomBtn.title, /receiver/i);

  dock.open('https://example.org/sdr', { kind: 'sdr', title: 'KiwiSDR' });
  assert.equal(kind.textContent, 'NOW PLAYING');
  assert.equal(root.getAttribute('aria-label'), 'Now playing');
  assert.doesNotMatch(zoomBtn.title, /receiver/i);
  dock.destroy();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioDock, audioDockUrl } from './audioDock.js';

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
  assert.equal(elements.kind.textContent, 'SDR');
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
  assert.equal(elements.kind.textContent, 'LIVEATC');
  assert.equal(elements.note.hidden, true, 'no note this time');
  elements.popoutBtn.listeners.click();
  assert.deepEqual(opened, ['https://www.liveatc.net/search/?icao=KAUS']);
  dock.toggleSize();
  assert.equal(dock.getState().size, 'large');
  assert.match(stored.get('gev.audioDock.v1'), /"size":"large"/);
  dock.close();
  assert.equal(elements.frame.getAttribute('src'), 'about:blank');
  assert.equal(elements.root.hidden, true);
  assert.deepEqual(seen, [false, true, true, false]);
  dock.destroy();
});

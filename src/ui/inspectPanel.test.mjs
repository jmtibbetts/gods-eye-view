import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InspectPanel,
  inspectActions,
  inspectKicker,
  inspectLines,
  instantText,
  sourceText,
  pinValueFor,
  vesselStatusText,
} from './inspectPanel.js';

/* ------------------------------------------------------------------ *
 * Records as the context store holds them.
 * ------------------------------------------------------------------ */

function flight(overrides = {}) {
  return {
    id: 'a1b2c3',
    layerId: 'flights',
    layerName: 'Live Flights',
    source: 'adsb.lol',
    label: 'UAL123',
    latitude: 30.2,
    longitude: -97.7,
    properties: {
      name: 'UAL123',
      callsign: 'UAL123',
      registration: 'N12345',
      icao24: 'a1b2c3',
      altitude: '12,000 ft',
      speed: '280 kt',
      heading: '90°',
      route: 'AUS → ORD',
    },
    entity: { __gevContextId: 'a1b2c3' },
    ...overrides,
  };
}

function vessel(overrides = {}) {
  return {
    id: 'ais-367000001',
    layerId: 'ais-live-vessels',
    layerName: 'Live AIS Vessels',
    source: 'aisstream.io',
    label: 'MARMAC 304',
    latitude: 28.4,
    longitude: -80.6,
    properties: { mmsi: '367000001', type: 'Cargo', speedKt: 3.2, course: 180 },
    entity: {
      gevLabelModel: {
        title: 'MARMAC 304',
        details: ['MMSI 367000001', 'CARGO · 3.2 KT · 180°'],
      },
    },
    ...overrides,
  };
}

const ALL_CAPS = Object.freeze({
  canWatchCamera: true,
  canListenAtc: true,
  atcAnnotation: 'ATC Austin Tower 121.0',
  atcFollowing: false,
  canListenSdr: true,
  canListenScanner: true,
  canPin: true,
  pinned: false,
  imaging: true,
  canWatchIss: true,
  canFocusTfr: true,
  panelId: 'x-panel',
  panelName: 'X',
  canGoTo: true,
});

const ids = (actions) => actions.map((a) => a.id);

test('the header names the kind of thing, not the source', () => {
  assert.equal(inspectKicker(flight()), 'AIRCRAFT');
  assert.equal(inspectKicker(vessel()), 'VESSEL');
  assert.equal(inspectKicker({ layerId: 'sdr' }), 'RECEIVER');
  assert.equal(
    inspectKicker({ layerId: 'new-layer', layerName: 'Something New' }),
    'SOMETHING NEW',
  );
  assert.equal(inspectKicker(null), '');
});

test('an aircraft offers LISTEN and FOLLOW only when a controller frequency applies', () => {
  const withFreq = inspectActions(flight(), { ...ALL_CAPS, panelId: null });
  assert.deepEqual(ids(withFreq), ['listen', 'follow', 'pin']);
  assert.match(withFreq[0].title, /Austin Tower 121\.0/);
  const noFreq = inspectActions(flight(), {
    ...ALL_CAPS,
    panelId: null,
    atcAnnotation: null,
  });
  assert.deepEqual(ids(noFreq), ['pin']);
  const noAtc = inspectActions(flight(), {
    ...ALL_CAPS,
    panelId: null,
    canListenAtc: false,
  });
  assert.deepEqual(ids(noAtc), ['pin']);
});

test('FOLLOW reads its state from the Airband section', () => {
  const [, follow] = inspectActions(flight(), {
    ...ALL_CAPS,
    panelId: null,
    atcFollowing: true,
  });
  assert.equal(follow.label, 'FOLLOWING');
  assert.equal(follow.active, true);
});

test('a tracked thing never offers GO TO — the camera is already on it', () => {
  assert.ok(!ids(inspectActions(flight(), ALL_CAPS)).includes('goto'));
  assert.ok(
    !ids(
      inspectActions({ id: '25544', layerId: 'satellites' }, ALL_CAPS),
    ).includes('goto'),
  );
  assert.ok(ids(inspectActions(vessel(), ALL_CAPS)).includes('goto'));
});

test('the ISS offers WATCH; an imaging satellite offers its SENSORS panel', () => {
  const iss = inspectActions(
    {
      id: '25544',
      layerId: 'satellites',
      properties: { name: 'ISS (ZARYA)' },
    },
    { ...ALL_CAPS, panelId: 'sensors-panel', panelName: 'SENSORS' },
  );
  assert.deepEqual(ids(iss), ['sensors', 'watch', 'pin']);
  assert.equal(iss[0].label, 'SENSORS PANEL ›');
  const noaa = inspectActions(
    { id: '43013', layerId: 'satellites', properties: { name: 'NOAA 20' } },
    { ...ALL_CAPS, panelId: 'sensors-panel', panelName: 'SENSORS' },
  );
  assert.deepEqual(ids(noaa), ['sensors', 'pin']);
  const other = inspectActions(
    { id: '99999', layerId: 'satellites', properties: { name: 'X' } },
    {
      ...ALL_CAPS,
      imaging: false,
      panelId: 'sensors-panel',
      panelName: 'SENSORS',
    },
  );
  // Not an imager, but SENSORS still predicts its passes — the generic link.
  assert.deepEqual(ids(other), ['pin', 'panel']);
  const noStream = inspectActions(
    { id: '25544', layerId: 'satellites', properties: { name: 'ISS' } },
    { ...ALL_CAPS, canWatchIss: false, panelId: null },
  );
  assert.ok(!ids(noStream).includes('watch'));
});

test('receivers, scanners and airports offer LISTEN when their layer can play', () => {
  const sdr = { id: 'sdr:abc', layerId: 'sdr', latitude: 1, longitude: 2 };
  assert.deepEqual(ids(inspectActions(sdr, { ...ALL_CAPS, panelId: null })), [
    'listen',
    'goto',
  ]);
  assert.deepEqual(
    ids(
      inspectActions(sdr, { ...ALL_CAPS, canListenSdr: false, panelId: null }),
    ),
    ['goto'],
  );
  const scanner = {
    id: 'scanner:kc',
    layerId: 'scanner',
    latitude: 1,
    longitude: 2,
    properties: { system: 'kc' },
  };
  assert.deepEqual(
    ids(inspectActions(scanner, { ...ALL_CAPS, panelId: null })),
    ['listen', 'goto'],
  );
  const airport = { id: 'atc:KAUS', layerId: 'atc', latitude: 1, longitude: 2 };
  assert.deepEqual(
    ids(inspectActions(airport, { ...ALL_CAPS, panelId: null })),
    ['listen', 'goto'],
  );
});

test('a camera offers WATCH, which opens the console that holds its frame', () => {
  const camera = {
    id: 'cctv:aus-12',
    layerId: 'cctv',
    layerName: 'Cameras',
    latitude: 30.2,
    longitude: -97.7,
    properties: {
      camera: 'aus-12',
      place: 'Austin, TX',
      provider: 'TxDOT',
      feed: 'mp4',
    },
  };
  const actions = inspectActions(camera, {
    ...ALL_CAPS,
    panelId: 'cctv-panel',
    panelName: 'CAMERAS',
  });
  assert.deepEqual(ids(actions), ['watch', 'panel', 'goto']);
  const noConsole = inspectActions(camera, {
    ...ALL_CAPS,
    canWatchCamera: false,
    panelId: null,
  });
  assert.deepEqual(ids(noConsole), ['goto']);
  // The operator is the card's source line, so the body does not repeat it.
  assert.deepEqual(inspectLines(camera).lines, ['Austin, TX', 'VIDEO FEED']);
  assert.deepEqual(
    inspectLines({
      layerId: 'cctv',
      properties: { camera: 'x', place: 'Denver, CO', feed: 'jpeg' },
    }).lines,
    ['Denver, CO', 'STILL FRAMES'],
  );
});

test('an instant is read as a time, with how far off it is while that matters', () => {
  const now = Date.parse('2026-09-20T04:00:00Z');
  assert.equal(
    instantText('2026-09-20T06:15:00-04:00', now),
    '20 SEP 10:15Z · in 6 h 15 min',
  );
  assert.equal(
    instantText('2026-09-20T04:30:00Z', now),
    '20 SEP 04:30Z · in 30 min',
  );
  assert.equal(
    instantText('2026-09-19T22:00:00Z', now),
    '19 SEP 22:00Z · 6 h ago',
  );
  // Far enough away that the offset stops being the useful part.
  assert.equal(instantText('2026-10-30T10:00:00Z', now), '30 OCT 10:00Z');
  // Another year is named, so a stamp is never ambiguous.
  assert.equal(instantText('2025-01-02T03:04:00Z', now), '2 JAN 2025 03:04Z');
  assert.equal(instantText('not a date', now), '');
  assert.equal(instantText('', now), '');
});

test('a generic card reads its times, and never repeats its own title', () => {
  const { title, lines } = inspectLines({
    layerId: 'weather-alerts',
    label: 'FLOOD ADVISORY',
    properties: {
      event: 'Flood Advisory',
      severity: 'Minor',
      area: 'Pickaway, OH; Ross, OH',
      expires: '2026-09-20T06:15:00-04:00',
      // Not a date, even though it starts with digits.
      time: '1800',
    },
  });
  assert.equal(title, 'FLOOD ADVISORY');
  assert.ok(
    !lines.some((line) => /^EVENT/.test(line)),
    'the event repeats the title, so it is not a second fact',
  );
  assert.ok(lines.includes('SEVERITY Minor'));
  assert.ok(lines.includes('TIME 1800'), 'a bare number is left alone');
  const expires = lines.find((line) => line.startsWith('EXPIRES'));
  assert.match(expires, /^EXPIRES 20 SEP 10:15Z/);
  assert.doesNotMatch(
    expires,
    /T06:15/,
    'the feed spelling does not reach the card',
  );
});

test('the card credits its source once, not the layer and the source', () => {
  // The header already says RECEIVER; "SDR Receivers · Web SDR directory"
  // under it said receiver twice more.
  assert.equal(
    sourceText({ layerName: 'SDR Receivers', source: 'Web SDR directory' }),
    'Web SDR directory',
  );
  assert.equal(sourceText({ layerName: 'Cameras', source: 'TxDOT' }), 'TxDOT');
  // A record that names no source falls back to the layer.
  assert.equal(sourceText({ layerName: 'Some Layer' }), 'Some Layer');
  assert.equal(sourceText({}), '');
  assert.equal(sourceText(null), '');
});

test('a closure offers its NOTAM only when the FAA page is known', () => {
  const tfr = {
    id: 'tfr:1',
    layerId: 'tfr',
    latitude: 1,
    longitude: 2,
    properties: { notam: '6/1234', page: 'https://tfr.faa.gov/x' },
  };
  assert.deepEqual(ids(inspectActions(tfr, { ...ALL_CAPS, panelId: null })), [
    'notam',
    'goto',
  ]);
  const noPage = { ...tfr, properties: { notam: '6/1234' } };
  assert.deepEqual(
    ids(inspectActions(noPage, { ...ALL_CAPS, panelId: null })),
    ['goto'],
  );
});

test('a ship pins by MMSI and links to VESSEL WATCH', () => {
  const actions = inspectActions(vessel(), {
    ...ALL_CAPS,
    panelId: 'vessel-watch-panel',
    panelName: 'VESSEL WATCH',
  });
  assert.deepEqual(ids(actions), ['pin', 'panel', 'goto']);
  assert.match(actions[0].title, /367000001/);
  assert.equal(actions[1].label, 'VESSEL WATCH PANEL ›');
  assert.equal(pinValueFor(vessel()), '367000001');
  assert.equal(pinValueFor(flight()), 'UAL123');
  assert.equal(
    pinValueFor(flight({ properties: { registration: 'n1', icao24: 'a1' } })),
    'N1',
  );
  assert.equal(pinValueFor({ layerId: 'sdr' }), '');
});

test('nothing selected, nothing offered; a pinned thing says so', () => {
  assert.deepEqual(inspectActions(null, ALL_CAPS), []);
  const [pin] = inspectActions(vessel(), {
    ...ALL_CAPS,
    pinned: true,
    panelId: null,
    canGoTo: false,
  });
  assert.equal(pin.label, 'PINNED');
  assert.equal(pin.active, true);
});

test('the VESSEL WATCH verdict is stated only as far as the table allows', () => {
  assert.equal(vesselStatusText(null), '');
  assert.equal(
    vesselStatusText({
      listed: { program: 'RUSSIA-EO14024' },
      tableLoaded: true,
    }),
    'OFAC-LISTED · RUSSIA-EO14024',
  );
  assert.equal(
    vesselStatusText({ listed: null, tableLoaded: true }),
    'NOT ON THE OFAC LIST',
  );
  assert.equal(
    vesselStatusText({
      listed: null,
      tableLoaded: false,
      tableError: 'HTTP 503',
    }),
    'OFAC LIST UNAVAILABLE',
  );
  assert.equal(
    vesselStatusText({ listed: null, tableLoaded: true, darkText: '42 min' }),
    'NOT ON THE OFAC LIST · DARK · 42 min',
  );
});

test('card lines come from the layer card when it drew one, else the flat properties', () => {
  const fromModel = inspectLines(vessel());
  assert.equal(fromModel.title, 'MARMAC 304');
  assert.deepEqual(fromModel.lines, [
    'MMSI 367000001',
    'CARGO · 3.2 KT · 180°',
  ]);

  const fromProps = inspectLines({
    id: 'x:1',
    layerId: 'some-layer',
    label: 'Somewhere',
    properties: {
      url: 'http://example.org',
      software: 'kiwisdr',
      bandLowHz: 0,
      note: null,
      liveAtcUrl: 'https://liveatc.net/x',
      link: 'https://elsewhere',
    },
  });
  assert.equal(fromProps.title, 'Somewhere');
  assert.deepEqual(fromProps.lines, ['SOFTWARE kiwisdr', 'BAND LOW HZ 0']);

  // Radio layers read as a sentence, not a property dump.
  assert.deepEqual(
    inspectLines({
      layerId: 'sdr',
      label: 'Camden KiwiSDR',
      properties: { url: 'http://x', bandLowHz: 0, bandHighHz: 30e6 },
    }).lines,
    ['COVERS 0–30 MHz'],
  );
  assert.deepEqual(
    inspectLines({
      layerId: 'sdr',
      properties: { bandLowHz: 24e6, bandHighHz: 1.766e9 },
    }).lines,
    ['COVERS 24 MHz–1.8 GHz'],
  );
  assert.deepEqual(
    inspectLines({
      layerId: 'ais-live-vessels',
      properties: {
        mmsi: '211511770',
        type: '83',
        typeName: 'TANKER',
        speedKt: 0.1,
        course: 92.2,
        destination: 'LINGEN',
      },
    }).lines,
    ['TANKER · 0.1 KT · 92°', '→ LINGEN', 'MMSI 211511770'],
  );
  assert.deepEqual(
    inspectLines({
      layerId: 'scanner',
      properties: { system: 'kc', callsPerMinute: 2.35, listeners: 12 },
    }).lines,
    ['2.4 CALLS / MIN', '12 LISTENING NOW'],
  );
  assert.deepEqual(
    inspectLines({
      layerId: 'atc',
      properties: {
        place: 'Austin, TX',
        towered: 'yes',
        towerHours: '24',
        radioCall: 'Austin Tower',
        twr: '121.000',
        gnd: '121.900',
        liveAtcUrl: 'https://liveatc.net/x',
      },
    }).lines,
    [
      'Austin, TX',
      'TWR 121.000 · GND 121.900',
      'TOWERED · 24 H',
      'CALL "Austin Tower"',
    ],
  );

  // A tracked aircraft's card lives on the viewer's tracked entity.
  const tracked = inspectLines(flight(), {
    trackedEntity: {
      gevLabelModel: { title: 'UAL123 · N12345', details: ['FL120 · 280 KT'] },
    },
    annotation: 'ATC Austin Tower 121.0',
  });
  assert.equal(tracked.title, 'UAL123 · N12345');
  assert.deepEqual(tracked.lines, ['FL120 · 280 KT', 'ATC Austin Tower 121.0']);
  assert.deepEqual(inspectLines(null), { title: '', lines: [] });
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
    attrs: {},
    hidden: false,
    children: [],
    _listeners: {},
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = String(value);
      node.children = [];
    },
    setAttribute(k, v) {
      node.attrs[k] = v;
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

function* walk(root) {
  for (const child of root.children || []) {
    yield child;
    yield* walk(child);
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function buttons(root) {
  return [...walk(root)].filter((n) => n.tagName === 'button');
}

/** A window double: events dispatch synchronously, timers fire by hand. */
function fakeWindow() {
  const listeners = new Map();
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    addEventListener(type, fn) {
      (listeners.get(type) || listeners.set(type, []).get(type)).push(fn);
    },
    dispatch(type) {
      for (const fn of listeners.get(type) || []) fn({ type });
    },
    setTimeout(fn) {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeout(id) {
      timeouts[id - 1] = null;
    },
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval(id) {
      intervals[id - 1] = null;
    },
    flush() {
      const due = timeouts.splice(0).filter(Boolean);
      for (const fn of due) fn();
    },
  };
}

function panelWith({ selected = null, atc = null, enabled = new Set() } = {}) {
  const elements = {
    state: makeElement('span'),
    body: makeElement('div'),
    empty: makeElement('p'),
  };
  const toasts = [];
  const pinned = new Set();
  const opened = [];
  const flights = [];
  let current = selected;
  const windowRef = fakeWindow();
  const panel = new InspectPanel({
    elements,
    getSelected: () => current,
    viewer: {
      trackedEntity: null,
      camera: {
        positionCartographic: { height: 400_000 },
        flyTo: (options) => flights.push(options),
      },
    },
    atc: () => atc,
    pinWatch: (value) => {
      if (pinned.has(value)) return 'exists';
      pinned.add(value);
      return 'added';
    },
    isPinned: (value) => pinned.has(value),
    vesselStatus: () => ({ listed: null, tableLoaded: true, darkText: '' }),
    panelFor: (layerId) =>
      layerId === 'ais-live-vessels'
        ? { panelId: 'vessel-watch-panel', name: 'VESSEL WATCH' }
        : null,
    openPanel: (id) => opened.push(id),
    enableLayer: (id) => {
      enabled.add(id);
    },
    isLayerEnabled: (id) => enabled.has(id),
    onToast: (message) => toasts.push(message),
    windowRef,
  });
  return {
    panel,
    elements,
    toasts,
    pinned,
    opened,
    flights,
    windowRef,
    select: (record) => {
      current = record;
    },
  };
}

test('with nothing selected the section says READY and keeps its hint', async () => {
  await withFakeDom(() => {
    const { panel, elements, windowRef } = panelWith();
    panel.connect();
    assert.equal(elements.state.textContent, 'READY');
    assert.equal(elements.empty.hidden, false);
    assert.equal(elements.body.children.length, 0);
    assert.equal(windowRef.intervals.filter(Boolean).length, 1);
    panel.destroy();
    assert.equal(windowRef.intervals.filter(Boolean).length, 0);
  });
});

test('a selection renders its card, its verdict and its actions', async () => {
  await withFakeDom(() => {
    const { panel, elements, pinned, opened, flights, toasts } = panelWith({
      selected: vessel(),
    });
    panel.connect();
    assert.equal(elements.state.textContent, 'VESSEL');
    assert.equal(elements.empty.hidden, true);
    const [card] = elements.body.children;
    assert.equal(card.dataset.layerId, 'ais-live-vessels');
    const texts = [...walk(card)].map((n) => n.textContent);
    assert.ok(texts.includes('MARMAC 304'));
    assert.ok(texts.includes('MMSI 367000001'));
    assert.ok(texts.includes('NOT ON THE OFAC LIST'));
    const btns = buttons(card);
    assert.deepEqual(
      btns.map((b) => b.textContent),
      ['PIN', 'VESSEL WATCH PANEL ›', 'GO TO'],
    );
    btns[0].click();
    assert.ok(pinned.has('367000001'));
    assert.match(toasts.at(-1), /pinned 367000001/);
    btns[1].click();
    assert.deepEqual(opened, ['vessel-watch-panel']);
    btns[2].click();
    assert.equal(flights.length, 1);
    assert.equal(flights[0].duration, 1.6);
    panel.destroy();
  });
});

test('a re-render after PIN shows PINNED without a second toast on repeat', async () => {
  await withFakeDom(async () => {
    const { panel, elements, toasts } = panelWith({ selected: vessel() });
    panel.connect();
    buttons(elements.body)[0].click();
    await settle();
    const [pin] = buttons(elements.body);
    assert.equal(pin.textContent, 'PINNED');
    pin.click();
    await settle();
    assert.match(toasts.at(-1), /already pinned/);
    panel.destroy();
  });
});

test('LISTEN on an aircraft turns Airband on and plays its controller', async () => {
  await withFakeDom(async () => {
    const calls = [];
    const atc = {
      contactAnnotationText: () => 'ATC Austin Tower 121.0',
      getAtcUIState: () => ({ follow: { active: false } }),
      listenAtc: () => null,
      listenAtcContact: async () => {
        calls.push('listen');
        return { facility: 'Austin Tower' };
      },
      setAtcFollow: (on) => calls.push(`follow:${on}`),
    };
    const enabled = new Set();
    const { panel, elements } = panelWith({
      selected: flight(),
      atc,
      enabled,
    });
    panel.connect();
    assert.equal(elements.state.textContent, 'AIRCRAFT');
    const lines = [...walk(elements.body)].map((n) => n.textContent);
    assert.ok(lines.includes('ATC Austin Tower 121.0'));
    const [listen, follow] = buttons(elements.body);
    assert.equal(listen.textContent, 'LISTEN');
    assert.equal(follow.textContent, 'FOLLOW');
    listen.click();
    await settle();
    assert.ok(enabled.has('atc'));
    assert.deepEqual(calls, ['listen']);
    buttons(elements.body)[1].click();
    await settle();
    assert.deepEqual(calls, ['listen', 'follow:true']);
    panel.destroy();
  });
});

test('selection events re-render one tick later, and the poll notices a change', async () => {
  await withFakeDom(() => {
    const { panel, elements, select, windowRef } = panelWith();
    panel.connect();
    assert.equal(elements.state.textContent, 'READY');
    select(vessel());
    windowRef.dispatch('gev:entity-selected');
    // Deferred: the tracking layers write the record after their event.
    assert.equal(elements.state.textContent, 'READY');
    windowRef.flush();
    assert.equal(elements.state.textContent, 'VESSEL');
    select(null);
    windowRef.intervals[0].fn();
    assert.equal(elements.state.textContent, 'READY');
    assert.equal(elements.empty.hidden, false);
    panel.destroy();
  });
});

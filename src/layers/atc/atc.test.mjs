import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAtcDirectory, normalizeAtcFrequency } from './records.js';
import {
  atcContactFromContext,
  atcDistanceKm,
  atcFacilityName,
  atcFollowTarget,
  atcFrequencyFor,
  atcNearestAirports,
  atcPhaseFor,
  createAtcSelectedOverlayEntry,
} from './model.js';
import { liveAtcAirportUrl } from './policy.js';
import { createBundledAtcSource } from './source.js';
import { createAtcLayer } from './index.js';

const AUS = {
  id: 'KAUS',
  faa: 'AUS',
  name: 'Austin-Bergstrom Intl',
  city: 'Austin',
  region: 'TX',
  country: 'US',
  lat: 30.1945,
  lon: -97.6699,
  elevFt: 542,
  tower: 'ATCT-TRACON',
  hours: '24',
  call: 'Austin',
  appCall: 'Austin',
  appProvider: 'AUS',
  freqs: [
    ['TWR', 121.0, ''],
    ['TWR', 118.225, '', 1],
    ['GND', 121.9, ''],
    ['CLD', 125.5, ''],
    ['APP', 119.0, 'West'],
    ['APP', 120.875, 'South'],
    ['ATIS', 124.4, ''],
    ['UNICOM', 122.95, ''],
  ],
};
const GTU = {
  id: 'KGTU',
  faa: 'GTU',
  name: 'Georgetown Exec',
  city: 'Georgetown',
  region: 'TX',
  country: 'US',
  lat: 30.6788,
  lon: -97.6794,
  elevFt: 790,
  tower: 'ATCT',
  hours: '0700-2200',
  call: 'Georgetown',
  appCall: 'Austin',
  appProvider: 'AUS',
  freqs: [
    ['TWR', 120.225, ''],
    ['GND', 119.125, ''],
    ['CTAF', 120.225, ''],
  ],
};
const T74 = {
  id: 'T74',
  faa: 'T74',
  name: 'Taylor Muni',
  city: 'Taylor',
  region: 'TX',
  country: 'US',
  lat: 30.5726,
  lon: -97.4432,
  elevFt: 600,
  freqs: [
    ['CTAF', 122.8, ''],
    ['WX', 118.575, 'Awos-3'],
  ],
};
const PAYLOAD = {
  _meta: {
    built: '2026-09-17',
    sources: { US: 'FAA NASR effective 2026-09-03' },
  },
  airports: [
    AUS,
    GTU,
    T74,
    { id: 'BAD', lat: 200, lon: 0, freqs: [['TWR', 118.1]] },
  ],
  centers: [
    {
      id: 'AUS-RCAG',
      artcc: 'ZHU',
      name: 'Austin RCAG',
      lat: 30.3,
      lon: -97.8,
      freqs: [
        [128.05, 'Low sector'],
        [351.9, 'UHF'],
      ],
    },
  ],
};

test('directory rows are validated, UHF dropped, positions typed', () => {
  const directory = normalizeAtcDirectory(PAYLOAD);
  assert.equal(directory.airports.length, 3);
  const aus = directory.airports[0];
  assert.equal(aus.towered, true);
  assert.equal(aus.freqs[1].secondary, true);
  assert.equal(aus.freqs[1].position, 'TWR');
  const t74 = directory.airports[2];
  assert.equal(t74.towered, false);
  assert.equal(t74.freqs[1].position, 'WX');
  assert.equal(directory.centers.length, 1);
  assert.deepEqual(
    directory.centers[0].freqs.map((f) => f.mhz),
    [128.05],
    'UHF center frequency is dropped',
  );
  assert.equal(normalizeAtcFrequency(['TWR', 254.25]), null);
  assert.equal(normalizeAtcFrequency(['NOPE', 121.0]), null);
  assert.equal(normalizeAtcDirectory({ airports: 'x' }), null);
});

test('nearest airports rank by distance and honour towered-only and text filters', () => {
  const { airports } = normalizeAtcDirectory(PAYLOAD);
  const near = atcNearestAirports(airports, {
    lat: 30.6,
    lon: -97.5,
    limit: 5,
  });
  assert.deepEqual(
    near.map((a) => a.id),
    ['T74', 'KGTU', 'KAUS'],
  );
  assert.ok(near[0].distanceKm < near[1].distanceKm);
  assert.deepEqual(
    atcNearestAirports(airports, {
      lat: 30.6,
      lon: -97.5,
      toweredOnly: true,
    }).map((a) => a.id),
    ['KGTU', 'KAUS'],
  );
  assert.deepEqual(
    atcNearestAirports(airports, {
      lat: 30.6,
      lon: -97.5,
      query: 'austin',
    }).map((a) => a.id),
    ['KAUS'],
  );
});

test('frequency choice walks the fallback chain', () => {
  const { airports } = normalizeAtcDirectory(PAYLOAD);
  const [aus, gtu, t74] = airports;
  assert.equal(
    atcFrequencyFor(aus, 'TWR').mhz,
    121.0,
    'primary before secondary',
  );
  assert.equal(
    atcFrequencyFor(aus, 'DEP').mhz,
    119.0,
    'departure falls back to approach',
  );
  assert.equal(
    atcFrequencyFor(gtu, 'CLD').mhz,
    119.125,
    'clearance falls back to ground',
  );
  assert.equal(
    atcFrequencyFor(t74, 'TWR').mhz,
    122.8,
    'untowered tower request → CTAF',
  );
  assert.equal(atcFrequencyFor(t74, 'ATIS').mhz, 118.575, 'ATIS → weather');
  assert.equal(
    atcFrequencyFor(t74, 'APP').mhz,
    122.8,
    'no radar service → CTAF',
  );
  assert.equal(atcFrequencyFor(t74, 'CLD'), null);
  assert.equal(atcFacilityName(aus, 'TWR'), 'Austin Tower');
  assert.equal(atcFacilityName(gtu, 'APP'), 'Austin Approach');
  assert.equal(atcFacilityName(t74, 'CTAF'), 'T74 CTAF');
});

test('the phase engine reads ground, tower, approach, departure and center', () => {
  const field = { distanceKm: 2, elevFt: 542 };
  assert.equal(atcPhaseFor({ onGround: true }, field), 'ground');
  assert.equal(
    atcPhaseFor(
      { altitudeFt: 1800, speedKt: 140 },
      { ...field, distanceKm: 6 },
    ),
    'tower',
  );
  assert.equal(
    atcPhaseFor(
      { altitudeFt: 6000, speedKt: 220 },
      { ...field, distanceKm: 30 },
    ),
    'approach',
  );
  assert.equal(
    atcPhaseFor(
      { altitudeFt: 6000, speedKt: 220, verticalFpm: 1800 },
      { ...field, distanceKm: 30 },
    ),
    'departure',
  );
  assert.equal(
    atcPhaseFor(
      { altitudeFt: 35000, speedKt: 450 },
      { ...field, distanceKm: 30 },
    ),
    'center',
  );
  assert.equal(
    atcPhaseFor({ altitudeFt: 3000 }, { ...field, distanceKm: 120 }),
    'center',
  );
  assert.equal(atcPhaseFor({ altitudeFt: 3000 }, null), 'center');
});

test('follow target routes approach through the provider TRACON and en-route to the Center site', () => {
  const directory = normalizeAtcDirectory(PAYLOAD);
  const byFaa = new Map(directory.airports.map((a) => [a.faa, a]));
  const dir = {
    airports: directory.airports,
    byFaa,
    centers: directory.centers,
  };
  // 30 km north of Georgetown at 7,000 ft → Georgetown is nearest towered, approach is Austin's.
  const inbound = atcFollowTarget(
    { lat: 30.95, lon: -97.68, altitudeFt: 7000, speedKt: 230 },
    dir,
  );
  assert.equal(inbound.phase, 'approach');
  assert.equal(inbound.airport.id, 'KAUS', 'approach comes from the provider');
  assert.equal(inbound.frequency.mhz, 119.0);
  // Short final at Georgetown → its own tower.
  const final = atcFollowTarget(
    { lat: 30.7, lon: -97.68, altitudeFt: 1500, speedKt: 110 },
    dir,
  );
  assert.equal(final.phase, 'tower');
  assert.equal(final.airport.id, 'KGTU');
  assert.equal(final.frequency.mhz, 120.225);
  // Cruise → nearest Center remote site.
  const cruise = atcFollowTarget(
    { lat: 30.3, lon: -97.7, altitudeFt: 36000, speedKt: 460 },
    dir,
  );
  assert.equal(cruise.phase, 'center');
  assert.equal(cruise.position, 'CTR');
  assert.equal(cruise.center.artcc, 'ZHU');
  assert.equal(cruise.frequency.mhz, 128.05);
  // No Center data at all (outside the US) → nearest approach instead.
  const abroad = atcFollowTarget(
    { lat: 30.3, lon: -97.7, altitudeFt: 36000, speedKt: 460 },
    { ...dir, centers: [] },
  );
  assert.equal(abroad.position, 'APP');
  assert.equal(abroad.airport.id, 'KAUS');
});

test('tracked-contact context text is parsed into numbers', () => {
  const contact = atcContactFromContext({
    id: 'a1b2c3',
    layerId: 'flights',
    label: 'UAL123',
    latitude: 30.2,
    longitude: -97.7,
    properties: {
      altitude: '12,500 ft',
      speed: '280 kt',
      route: 'KAUS → KDEN',
    },
  });
  assert.equal(contact.altitudeFt, 12500);
  assert.equal(contact.speedKt, 280);
  assert.equal(contact.onGround, false);
  assert.equal(contact.route, 'KAUS → KDEN');
  assert.equal(
    atcContactFromContext({
      id: 'x',
      layerId: 'flights',
      latitude: 1,
      longitude: 2,
      properties: { altitude: 'on ground' },
    }).onGround,
    true,
  );
  assert.equal(atcContactFromContext(null), null);
});

test('LiveATC hand-off URLs are code-only and the selected card lists the positions', () => {
  assert.equal(
    liveAtcAirportUrl('kaus'),
    'https://www.liveatc.net/search/?icao=KAUS',
  );
  assert.equal(
    liveAtcAirportUrl('K A"US'),
    'https://www.liveatc.net/search/?icao=KAUS',
  );
  assert.equal(liveAtcAirportUrl(''), '');
  const { airports } = normalizeAtcDirectory(PAYLOAD);
  const entry = createAtcSelectedOverlayEntry({
    id: 'atc:KAUS',
    position: null,
    airport: airports[0],
  });
  assert.equal(entry.title, 'KAUS · Austin-Bergstrom Intl');
  assert.match(
    entry.details[1],
    /Tower 121\.000 · Ground 121\.900 · Clearance 125\.500/,
  );
  assert.equal(atcDistanceKm(0, 0, 0, 1).toFixed(0), '111');
});

test('the bundled source validates the payload and honours abort', async () => {
  const source = createBundledAtcSource({
    fetchImpl: async () =>
      new Response(JSON.stringify(PAYLOAD), { status: 200 }),
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.airports.length, 3);
  assert.equal(snapshot.builtAt, '2026-09-17');
  const bad = createBundledAtcSource({
    fetchImpl: async () => new Response('{"nope":1}', { status: 200 }),
  });
  await assert.rejects(bad.getSnapshot(), /Malformed ATC directory/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(source.getSnapshot({ signal: aborted.signal }));
});

function fakeViewer() {
  const removed = [];
  return {
    removed,
    scene: { canvas: {}, pick: () => null },
    camera: { positionWC: null, positionCartographic: { height: 200_000 } },
    dataSources: {
      add() {},
      remove(ds) {
        removed.push(ds);
      },
    },
    entities: {
      add: (e) => e,
      remove() {},
    },
  };
}

function fakeOverlayHost() {
  const calls = [];
  return {
    calls,
    setEntries: (...a) => calls.push(['entries', ...a]),
    setVisible: (...a) => calls.push(['visible', ...a]),
    clearSource: (...a) => calls.push(['clear', ...a]),
  };
}

test('the layer lists, selects, listens (SDR first, LiveATC fallback) and follows a selected plane', async () => {
  const opened = [];
  let selectedContext = null;
  const context = {
    registerEntityContext: () => ({}),
    selectEntityContext: () => ({}),
    clearSelectedEntityContextForLayer: () => {},
    getSelectedEntityContext: () => selectedContext,
  };
  const events = new EventTarget();
  let sdrHits = 0;
  const layer = createAtcLayer({
    source: createBundledAtcSource({
      fetchImpl: async () =>
        new Response(JSON.stringify(PAYLOAD), { status: 200 }),
    }),
    overlayHost: fakeOverlayHost(),
    context,
    eventTarget: events,
    openUrl: (url, meta) => opened.push({ url, meta }),
    findSdr: async ({ freqHz }) => {
      sdrHits++;
      return freqHz === 121_000_000
        ? {
            receiver: { name: 'Westy RX', distanceKm: 12 },
            url: 'http://rx.example/?f=121000amz8',
          }
        : null;
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  const state = layer.getAtcUIState();
  assert.equal(state.airports, 3);
  assert.equal(state.towered, 2);
  assert.deepEqual(
    layer
      .findAtcAirports({ lat: 30.2, lon: -97.67, limit: 2 })
      .map((a) => a.id),
    ['KAUS', 'T74'],
  );

  assert.equal(layer.selectAtcAirport('KAUS'), true);
  const listened = await layer.listenAtc({});
  assert.equal(listened.via, 'sdr', 'an airband SDR in range wins');
  assert.equal(listened.frequency.mhz, 121.0);
  assert.equal(opened.at(-1).meta.kind, 'sdr');
  assert.equal(opened.at(-1).meta.title, 'Austin Tower');

  const ground = await layer.listenAtc({ position: 'GND' });
  assert.equal(ground.via, 'liveatc', 'no SDR covers 121.9 → LiveATC page');
  assert.equal(ground.url, 'https://www.liveatc.net/search/?icao=KAUS');
  assert.match(opened.at(-1).meta.note, /121\.900 MHz/);

  const byFaa = await layer.listenAtc({ airportId: 'gtu', position: 'TWR' });
  assert.equal(byFaa.airport.id, 'KGTU', 'FAA ids resolve to the ICAO row');

  // Follow: a selected flight on short final at Austin retunes to Austin Tower.
  const before = opened.length;
  selectedContext = {
    id: 'abc123',
    layerId: 'flights',
    label: 'SWA1',
    latitude: 30.25,
    longitude: -97.68,
    properties: { altitude: '1,200 ft', speed: '130 kt' },
  };
  layer.setAtcFollow(true);
  await new Promise((r) => setTimeout(r, 20));
  const follow = layer.getAtcUIState().follow;
  assert.equal(follow.active, true);
  assert.equal(follow.phase, 'tower');
  assert.equal(follow.contact.label, 'SWA1');
  assert.equal(opened.length, before + 1, 'follow opened the tower once');
  assert.equal(layer.getAtcListening().reason, 'follow');
  // The same target again does not reopen the window.
  events.dispatchEvent(
    new CustomEvent('gev:awareness-subject-selected', {
      detail: { layerId: 'flights' },
    }),
  );
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(opened.length, before + 1);
  // Clearing the plane clears the follow contact but keeps follow armed.
  selectedContext = null;
  events.dispatchEvent(
    new CustomEvent('gev:awareness-subject-cleared', {
      detail: { layerId: 'flights' },
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(layer.getAtcUIState().follow.contact, null);
  assert.equal(layer.getAtcUIState().follow.active, true);
  assert.ok(sdrHits >= 3);

  assert.ok(layer.getAnalystRecords(10).every((r) => r.towered));
  layer.disable();
  assert.equal(
    layer.getAtcUIState().follow.active,
    true,
    'follow survives disable',
  );
  assert.equal(layer.getAtcListening(), null);
  layer.destroy(viewer);
  assert.equal(viewer.removed.length, 1);
});

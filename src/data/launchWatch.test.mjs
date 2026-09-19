import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRBAND_HZ,
  LAUNCH_WATCH_FLOWN_LINGER_MS,
  countdownText,
  distanceKm,
  launchPhase,
  listenSourcesFor,
  normalizeLaunchWatch,
  phaseLabel,
  primaryWebcast,
  sortForWatch,
  watchableLaunches,
  webcastEmbedUrl,
} from './launchWatch.js';

const NOW = Date.parse('2026-09-19T12:00:00Z');

/** A Launch Library 2 record, detailed mode, trimmed to what the watch reads. */
function ll2(overrides = {}) {
  return {
    id: 'abc-123',
    name: 'Falcon 9 Block 5 | Starlink Group 15-27',
    status: { abbrev: 'Go', name: 'Go for Launch' },
    net: '2026-09-19T14:30:00Z',
    net_precision: { name: 'Second' },
    window_start: '2026-09-19T14:30:00Z',
    window_end: '2026-09-19T18:30:00Z',
    probability: 90,
    weather_concerns: null,
    holdreason: null,
    failreason: null,
    webcast_live: false,
    launch_service_provider: { name: 'SpaceX', abbrev: 'SpX' },
    rocket: { configuration: { full_name: 'Falcon 9 Block 5' } },
    mission: { name: 'Starlink Group 15-27', orbit: { name: 'Low Earth Orbit' } },
    pad: {
      name: 'Space Launch Complex 4E',
      latitude: '34.632',
      longitude: '-120.611',
      location: { name: 'Vandenberg SFB, CA, USA', country: { alpha_2_code: 'US' } },
    },
    vid_urls: [
      {
        priority: 10,
        source: 'x.com',
        publisher: 'SpaceX',
        title: 'Starlink Mission',
        url: 'https://x.com/i/broadcasts/1nxnRBXEladxO',
        live: false,
      },
      {
        priority: 5,
        source: 'youtube.com',
        publisher: 'Spaceflight Now',
        title: 'Live coverage',
        url: 'https://www.youtube.com/watch?v=AnN8Pj8WvSo',
        live: false,
      },
    ],
    updates: [
      { comment: 'Added launch.', created_on: '2026-09-10T00:00:00Z' },
      { comment: 'Go for launch.', created_on: '2026-09-19T10:00:00Z' },
    ],
    ...overrides,
  };
}

test('YouTube pages become the tracking-free embed; everything else stays on its own site', () => {
  assert.equal(
    webcastEmbedUrl('https://www.youtube.com/watch?v=AnN8Pj8WvSo'),
    'https://www.youtube-nocookie.com/embed/AnN8Pj8WvSo?autoplay=1',
  );
  assert.equal(
    webcastEmbedUrl('https://youtu.be/AnN8Pj8WvSo'),
    'https://www.youtube-nocookie.com/embed/AnN8Pj8WvSo?autoplay=1',
  );
  assert.equal(
    webcastEmbedUrl('https://www.youtube.com/live/AnN8Pj8WvSo?feature=share'),
    'https://www.youtube-nocookie.com/embed/AnN8Pj8WvSo?autoplay=1',
  );
  // X broadcasts, NASA+ and operator sites refuse framing: no embed.
  assert.equal(webcastEmbedUrl('https://x.com/i/broadcasts/1nxnRBXEladxO'), null);
  assert.equal(webcastEmbedUrl('https://plus.nasa.gov/scheduled-video/x'), null);
  // A watch URL without an id, or a bogus id, must not produce a frame.
  assert.equal(webcastEmbedUrl('https://www.youtube.com/watch'), null);
  assert.equal(webcastEmbedUrl('https://www.youtube.com/watch?v=<script>'), null);
  assert.equal(webcastEmbedUrl('javascript:alert(1)'), null);
  assert.equal(webcastEmbedUrl(null), null);
});

test('records keep the clock, the pad, the state and the webcasts, framable first', () => {
  const [r] = normalizeLaunchWatch({ results: [ll2()] });
  assert.equal(r.id, 'abc-123');
  assert.equal(r.net, '2026-09-19T14:30:00.000Z');
  assert.equal(r.provider, 'SpaceX');
  assert.equal(r.rocket, 'Falcon 9 Block 5');
  assert.equal(r.status.abbrev, 'Go');
  assert.equal(r.lat, 34.632);
  assert.equal(r.lon, -120.611);
  assert.equal(r.padName, 'Space Launch Complex 4E');
  assert.equal(r.siteName, 'Vandenberg SFB, CA, USA');
  assert.equal(r.probability, 90);
  assert.equal(r.latestUpdate.comment, 'Go for launch.');
  // The framable stream leads even though the publisher ranked X higher:
  // a WATCH that opens in the dock beats one that opens a tab.
  assert.equal(r.webcasts.length, 2);
  assert.equal(r.webcasts[0].publisher, 'Spaceflight Now');
  assert.match(r.webcasts[0].embedUrl, /youtube-nocookie/);
  assert.equal(r.webcasts[1].embedUrl, null);
  assert.equal(primaryWebcast(r).publisher, 'Spaceflight Now');
  // A live stream leads over a framable one: live is the point.
  const [live] = normalizeLaunchWatch([
    ll2({
      vid_urls: [
        { url: 'https://www.youtube.com/watch?v=AnN8Pj8WvSo', live: false, priority: 9 },
        { url: 'https://x.com/i/broadcasts/1', live: true, priority: 1, publisher: 'SpaceX' },
      ],
    }),
  ]);
  assert.equal(primaryWebcast(live).publisher, 'SpaceX');
  assert.equal(primaryWebcast(live).live, true);
});

test('a record survives missing pad, webcast and updates, and garbage is dropped', () => {
  const out = normalizeLaunchWatch({
    results: [
      ll2({ pad: null, vid_urls: null, updates: null, net: 'soon', probability: null }),
      null,
      'nope',
      { id: '' },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].lat, null);
  assert.equal(out[0].net, null);
  // null is "unknown", never 0 — a pad at 0°,0° or "0% weather go" would be a lie.
  assert.equal(out[0].probability, null);
  const [unknownPad] = normalizeLaunchWatch([
    ll2({ pad: { name: 'Pad', latitude: null, longitude: '' }, probability: -1 }),
  ]);
  assert.equal(unknownPad.lat, null);
  assert.equal(unknownPad.lon, null);
  assert.equal(unknownPad.probability, null);
  assert.deepEqual(out[0].webcasts, []);
  assert.equal(out[0].latestUpdate, null);
  assert.deepEqual(normalizeLaunchWatch(null), []);
  assert.deepEqual(normalizeLaunchWatch({}), []);
});

test('the phase follows the status first and the clock second', () => {
  const at = (net, abbrev = 'Go') =>
    launchPhase({ net, status: { abbrev } }, NOW);
  assert.equal(at('2026-09-19T14:30:00Z'), 'countdown');
  assert.equal(at('2026-09-19T12:20:00Z'), 'imminent');
  assert.equal(at('2026-09-19T12:20:00Z', 'TBC'), 'imminent');
  assert.equal(at('2026-09-19T12:20:00Z', 'TBD'), 'tbd');
  assert.equal(at('2026-09-19T14:30:00Z', 'Hold'), 'hold');
  assert.equal(at('2026-09-19T11:59:00Z', 'In Flight'), 'flying');
  assert.equal(at('2026-09-19T11:00:00Z', 'Success'), 'flown');
  assert.equal(at('2026-09-19T11:00:00Z', 'Failure'), 'flown');
  // Net has passed and the editors have not posted yet: a Go launch is
  // almost certainly climbing; give it twenty minutes before it reads as slipped.
  assert.equal(at('2026-09-19T11:50:00Z', 'Go'), 'flying');
  assert.equal(at('2026-09-19T11:30:00Z', 'Go'), 'tbd');
  assert.equal(at('2026-09-19T11:50:00Z', 'TBC'), 'tbd');
  assert.equal(at(null), 'tbd');
  assert.equal(launchPhase(null, NOW), 'tbd');
});

test('the chip says what the phase means, and the clock reads like a countdown', () => {
  assert.equal(phaseLabel('flying'), 'IN FLIGHT');
  assert.equal(phaseLabel('flown', { status: { abbrev: 'Success' } }), 'SUCCESS');
  assert.equal(phaseLabel('hold'), 'HOLD');
  assert.equal(phaseLabel('imminent'), 'IMMINENT');
  assert.equal(phaseLabel('countdown', { status: { abbrev: 'Go' } }), 'GO');
  assert.equal(phaseLabel('countdown', { status: { abbrev: 'TBC' } }), 'TO BE CONFIRMED');
  assert.equal(phaseLabel('tbd'), 'DATE TBD');
  assert.equal(countdownText('2026-09-19T13:23:45Z', NOW), 'T−01:23:45');
  assert.equal(countdownText('2026-09-19T12:00:00Z', NOW), 'T−00:00:00');
  assert.equal(countdownText('2026-09-19T11:56:50Z', NOW), 'T+00:03:10');
  assert.equal(countdownText('2026-09-21T16:00:00Z', NOW), 'T−2d 04:00:00');
  assert.equal(countdownText(null, NOW), null);
});

test('flown launches linger a few hours then drop; flying leads the list', () => {
  const records = normalizeLaunchWatch([
    ll2({ id: 'later', net: '2026-09-20T10:00:00Z' }),
    ll2({ id: 'flying', net: '2026-09-19T11:55:00Z', status: { abbrev: 'In Flight' } }),
    ll2({ id: 'old', net: '2026-09-19T06:00:00Z', status: { abbrev: 'Success' } }),
    ll2({ id: 'recent', net: '2026-09-19T10:30:00Z', status: { abbrev: 'Success' } }),
    ll2({ id: 'hold', net: '2026-09-19T13:00:00Z', status: { abbrev: 'Hold' } }),
    ll2({ id: 'soon', net: '2026-09-19T12:10:00Z' }),
    ll2({ id: 'tbd', net: '2026-09-19T12:05:00Z', status: { abbrev: 'TBD' } }),
  ]);
  const visible = watchableLaunches(records, NOW);
  assert.ok(!visible.some((r) => r.id === 'old'), 'six hours flown is gone');
  assert.ok(visible.some((r) => r.id === 'recent'), 'ninety minutes flown lingers');
  assert.ok(LAUNCH_WATCH_FLOWN_LINGER_MS >= 2 * 3600_000);
  assert.deepEqual(
    sortForWatch(visible, NOW).map((r) => r.id),
    ['flying', 'soon', 'later', 'hold', 'tbd', 'recent'],
  );
});

test('listen sources are what a radio near the pad can hear, each labelled for what it is', () => {
  const ksc = { lat: 28.608, lon: -80.604 };
  const sources = listenSourcesFor(ksc, {
    scannerSystems: [
      { id: 'nasaksc', name: 'Kennedy Space Center', desc: 'NASA Kennedy Space Center (Florida)', county: 'Brevard', state: 'FL', distanceKm: 48, callAvg: 0.9 },
      { id: 'orange', name: 'Orange County Government Florida', county: 'Orange', state: 'FL', distanceKm: 70, callAvg: 12 },
      { id: 'far', name: 'Miami-Dade', distanceKm: 300, callAvg: 40 },
    ],
    airports: [
      { id: 'KTTS', name: 'Space Florida Launch and Landing Facility', call: 'Nasa', towered: true, distanceKm: 9, freqs: [{ position: 'TWR', mhz: 128.55 }, { position: 'GND', mhz: 121.75 }, { position: 'APP', mhz: 134.95 }, { position: 'CTAF', mhz: 128.55 }] },
      { id: 'X21', name: 'Arthur Dunn Air Park', towered: false, distanceKm: 23, freqs: [{ position: 'CTAF', mhz: 122.8 }] },
      { id: 'KMCO', name: 'Orlando Intl', towered: true, distanceKm: 75, freqs: [{ position: 'TWR', mhz: 124.3 }] },
      { id: 'HELI', name: 'Shepherds Point', towered: false, distanceKm: 20, freqs: [{ position: 'WX', mhz: 119.3 }] },
    ],
    receivers: [
      { id: 'hf', name: '0-30 MHz SDR | Indian Harbour Beach', type: 'kiwisdr', url: 'http://a/', distanceKm: 50, bands: [0, 30_000_000] },
      { id: 'vhf', name: 'Airband WebSDR', type: 'websdr', url: 'http://b/', distanceKm: 120, ranges: [[0, 30_000_000], [118_000_000, 137_000_000]] },
      { id: 'unknown', name: 'Mystery', type: 'openwebrx', url: 'http://c/', distanceKm: 90 },
      { id: 'far', name: 'Tauranga', type: 'kiwisdr', url: 'http://d/', distanceKm: 13000, bands: [0, 30_000_000] },
    ],
  });
  // The range's own system leads, the county system follows, 300 km is out.
  assert.deepEqual(sources.scanner.map((s) => s.id), ['nasaksc', 'orange']);
  assert.equal(sources.scanner[0].onRange, true);
  assert.equal(sources.scanner[0].place, 'Brevard, FL');
  // The pad's own tower leads; a heliport with only a weather frequency and
  // an airport 75 km out are not "near the range".
  assert.deepEqual(sources.airband.map((a) => a.id), ['KTTS', 'X21']);
  assert.equal(sources.airband[0].onRange, true);
  assert.deepEqual(
    sources.airband[0].freqs.map((f) => f.position),
    ['TWR', 'GND', 'APP', 'CTAF'],
  );
  // The one receiver that covers airband leads; the HF-only one says so.
  assert.deepEqual(sources.sdr.map((r) => r.id), ['vhf', 'hf', 'unknown']);
  assert.equal(sources.sdr[0].coversAirband, true);
  assert.equal(sources.sdr[1].hfOnly, true);
  assert.equal(sources.sdr[2].rangeKnown, false);
  assert.deepEqual(AIRBAND_HZ, [118_000_000, 137_000_000]);
  // No pad: nothing to listen near.
  assert.deepEqual(listenSourcesFor({ lat: null, lon: null }, {}), {
    scanner: [],
    airband: [],
    sdr: [],
  });
  assert.ok(Math.abs(distanceKm(28.608, -80.604, 28.4676, -80.5666) - 16) < 1);
});

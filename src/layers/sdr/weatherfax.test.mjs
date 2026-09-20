import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEFAX_STATIONS,
  WEFAX_USB_OFFSET_HZ,
  activeFrequencies,
  chooseWefax,
  nearestWefaxStation,
  preferredFrequencies,
  utcMinutes,
  wefaxDialHz,
  wefaxNoticeText,
  withinWindow,
} from './weatherfax.js';

const station = (call) => WEFAX_STATIONS.find((s) => s.call === call);
const at = (iso) => new Date(iso);

test('the dial sits 1.9 kHz below the published frequency, because that is how radiofax tunes', () => {
  // Tuning the published number in USB gets noise: the picture is on
  // subcarriers above the carrier. This offset is the whole trick.
  assert.equal(WEFAX_USB_OFFSET_HZ, -1_900);
  assert.equal(wefaxDialHz(12_786_000), 12_784_100);
  assert.equal(wefaxDialHz(4_235_000), 4_233_100);
  assert.equal(wefaxDialHz(0), 0, 'never below zero');
});

test('a scheduled frequency is only offered inside its own window', () => {
  const boston = station('NMF');
  // 4235 kHz runs 0230–1039Z; 12750 kHz runs 1400–2239Z.
  assert.ok(
    activeFrequencies(boston, at('2026-09-20T05:00:00Z')).includes(4235),
  );
  assert.ok(
    !activeFrequencies(boston, at('2026-09-20T15:00:00Z')).includes(4235),
  );
  assert.ok(
    activeFrequencies(boston, at('2026-09-20T15:00:00Z')).includes(12750),
  );
  assert.ok(
    !activeFrequencies(boston, at('2026-09-20T05:00:00Z')).includes(12750),
  );
});

test('an around-the-clock frequency is always offered', () => {
  const boston = station('NMF');
  for (const hour of ['00', '06', '12', '18'])
    assert.ok(
      activeFrequencies(boston, at(`2026-09-20T${hour}:30:00Z`)).includes(9110),
      `9110 kHz missing at ${hour}:30Z`,
    );
});

test('a window that crosses midnight is still a window', () => {
  // Honolulu's 16135 kHz runs 1719–0356Z. Treating that as start<=end would
  // make it available only in the hours it is actually OFF.
  const honolulu = station('KVM70');
  const active = (iso) => activeFrequencies(honolulu, at(iso)).includes(16135);
  assert.equal(active('2026-09-20T18:00:00Z'), true, 'evening, inside');
  assert.equal(active('2026-09-20T02:00:00Z'), true, 'after midnight, inside');
  assert.equal(active('2026-09-20T10:00:00Z'), false, 'mid-morning, outside');
  assert.equal(withinWindow([1039, 236], 1200), true);
  assert.equal(withinWindow([1039, 236], 600), false);
  assert.equal(withinWindow(null, 600), true, 'no window means always');
});

test('utc minutes are read off the clock, not the local one', () => {
  assert.equal(utcMinutes(at('2026-09-20T00:00:00Z')), 0);
  assert.equal(utcMinutes(at('2026-09-20T17:19:00Z')), 1039);
  assert.equal(utcMinutes(at('2026-09-20T23:59:00Z')), 1439);
});

test('the nearest station is the one whose sea area you are in', () => {
  assert.equal(nearestWefaxStation(41, -69).station.call, 'NMF');
  assert.equal(nearestWefaxStation(26, -90).station.call, 'NMG');
  assert.equal(nearestWefaxStation(37, -125).station.call, 'NMC');
  assert.equal(nearestWefaxStation(57, -150).station.call, 'NOJ');
  assert.equal(nearestWefaxStation(56, 3).station.call, 'DDH/DDK');
  assert.equal(nearestWefaxStation(34, 140).station.call, 'JMH');
  assert.equal(nearestWefaxStation(-18, 155).station.call, 'VMC');
  assert.equal(nearestWefaxStation(NaN, 0), null);
});

test('the middle of the band is tried first, and the rest are offered', () => {
  const choice = chooseWefax({
    lat: 41,
    lon: -69,
    now: at('2026-09-20T15:00:00Z'),
  });
  assert.equal(choice.station.call, 'NMF');
  assert.equal(choice.khz, 9110, 'nearest 8 MHz of what is on air');
  assert.ok(choice.alternatives.includes(12750));
  assert.ok(!choice.alternatives.includes(4235), 'that one is off air now');
  assert.ok(!choice.alternatives.includes(choice.khz), 'no duplicate');
});

test('a frequency no receiver covers is skipped for one that is', () => {
  const only12750 = (dialHz) =>
    dialHz === wefaxDialHz(12_750_000) ? [{ name: 'RX', distanceKm: 10 }] : [];
  const choice = chooseWefax({
    lat: 41,
    lon: -69,
    now: at('2026-09-20T15:00:00Z'),
    receiversFor: only12750,
  });
  assert.equal(choice.khz, 12750);
  assert.equal(choice.receiver.name, 'RX');
});

test('no covering receiver at all is null rather than a frequency nobody can hear', () => {
  const choice = chooseWefax({
    lat: 41,
    lon: -69,
    now: at('2026-09-20T15:00:00Z'),
    receiversFor: () => [],
  });
  assert.equal(choice, null);
});

test('the notice explains the offset, the alternatives and the limit', () => {
  const choice = chooseWefax({
    lat: 41,
    lon: -69,
    now: at('2026-09-20T15:00:00Z'),
  });
  const text = wefaxNoticeText(choice);
  assert.match(text, /NMF/);
  assert.match(text, /1\.9 kHz low/, 'says why the dial looks wrong');
  assert.match(text, /12750 kHz/, 'offers the other frequency');
  assert.match(text, /decoding|software/i, 'does not imply it draws the chart');
  assert.equal(wefaxNoticeText(null), '');
});

test('every station is complete enough to tune and to name', () => {
  const calls = new Set();
  for (const entry of WEFAX_STATIONS) {
    assert.ok(!calls.has(entry.call), `${entry.call} duplicated`);
    calls.add(entry.call);
    assert.ok(entry.name && entry.region, `${entry.call} describes itself`);
    assert.ok(Number.isFinite(entry.lat) && Number.isFinite(entry.lon));
    assert.ok(entry.freqs.length > 0, `${entry.call} has frequencies`);
    for (const freq of entry.freqs) {
      assert.ok(
        freq.khz > 1000 && freq.khz < 30_000,
        `${entry.call} ${freq.khz} kHz is in the HF range`,
      );
      if (freq.window) {
        assert.equal(freq.window.length, 2);
        for (const minute of freq.window)
          assert.ok(
            minute >= 0 && minute <= 1439,
            `${entry.call} window minute`,
          );
      }
    }
  }
});

test('every station has something on air at any hour of the day', () => {
  // A station that goes silent for part of the day would hand a ship an
  // empty result rather than a chart.
  for (const entry of WEFAX_STATIONS)
    for (let hour = 0; hour < 24; hour += 1)
      assert.ok(
        preferredFrequencies(
          entry,
          at(`2026-09-20T${String(hour).padStart(2, '0')}:30:00Z`),
        ).length > 0,
        `${entry.call} has nothing at ${hour}:30Z`,
      );
});

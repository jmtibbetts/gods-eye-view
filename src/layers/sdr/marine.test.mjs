import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARINE_BANDS,
  MARINE_LADDER,
  MARINE_PRESET_IDS,
  MARINE_VHF_MAX_KM,
  chooseMarineListen,
  isLineOfSight,
  marineBand,
  marinePresets,
  marineRefusalText,
} from './marine.js';

const band = marineBand;

/** A directory that answers with one receiver at a fixed distance per band. */
function directory(distancesById) {
  return (candidate) => {
    const km = distancesById[candidate.id];
    return Number.isFinite(km)
      ? [
          {
            id: `rx-${candidate.id}`,
            name: `RX ${candidate.id}`,
            distanceKm: km,
          },
        ]
      : [];
  };
}

test('Channel 16 is only line-of-sight; the HF bands are not', () => {
  assert.equal(isLineOfSight(band('vhf-ch16')), true);
  assert.equal(isLineOfSight(band('hf-2182')), false);
  assert.equal(isLineOfSight(band('hf-8mhz')), false);
  assert.equal(isLineOfSight(null), false);
});

test('a ship off a covered coast gets Channel 16, not a shortwave band', () => {
  const chosen = chooseMarineListen({
    receiversFor: directory({ 'vhf-ch16': 40, 'hf-2182': 5 }),
  });
  assert.equal(chosen.band.id, 'vhf-ch16');
  assert.equal(chosen.receiver.distanceKm, 40);
});

test('a ship out of VHF range falls back to HF rather than to nothing', () => {
  const chosen = chooseMarineListen({
    receiversFor: directory({ 'vhf-ch16': 1400, 'hf-2182': 3000 }),
  });
  assert.equal(chosen.band.id, 'hf-2182');
  assert.equal(
    chosen.receiver.distanceKm,
    3000,
    'distance does not disqualify an ionospheric band',
  );
});

test('the VHF cutoff is enforced at its own edge', () => {
  const inside = chooseMarineListen({
    receiversFor: directory({ 'vhf-ch16': MARINE_VHF_MAX_KM }),
  });
  assert.equal(inside.band.id, 'vhf-ch16', 'exactly at the limit still counts');
  const outside = chooseMarineListen({
    receiversFor: directory({ 'vhf-ch16': MARINE_VHF_MAX_KM + 1 }),
  });
  assert.equal(outside.band, null);
});

test('with nothing in range at all, the refusal names the nearest VHF distance', () => {
  const outcome = chooseMarineListen({
    receiversFor: directory({ 'vhf-ch16': 900 }),
  });
  assert.equal(outcome.band, null);
  assert.equal(outcome.nearestVhf.distanceKm, 900);
  const text = marineRefusalText(outcome);
  assert.match(text, /900 km away/);
  assert.match(text, /line-of-sight/);
});

test('with no covering receiver anywhere, the refusal says that instead', () => {
  const outcome = chooseMarineListen({ receiversFor: () => [] });
  assert.equal(outcome.band, null);
  assert.equal(outcome.nearestVhf, null);
  assert.match(marineRefusalText(outcome), /none covers Channel 16/);
  assert.doesNotMatch(marineRefusalText(outcome), /km away/);
});

test('the ladder prefers the band a listener would rather hear', () => {
  // Every band reachable: the order of MARINE_BANDS decides, and Channel 16
  // is what people mean by marine radio.
  const chosen = chooseMarineListen({
    receiversFor: directory({
      'vhf-ch16': 10,
      'hf-2182': 10,
      'hf-8mhz': 10,
      'hf-4mhz': 10,
    }),
  });
  assert.equal(chosen.band.id, 'vhf-ch16');
  assert.equal(MARINE_BANDS[0].id, 'vhf-ch16');
});

test('every band is fully described, because each one is offered to a user', () => {
  for (const entry of MARINE_BANDS) {
    assert.ok(entry.label, `${entry.id} has a label`);
    assert.ok(entry.hint, `${entry.id} explains itself`);
    assert.ok(Number.isFinite(entry.freqHz) && entry.freqHz > 0);
    assert.ok(['nbfm', 'usb', 'lsb', 'am'].includes(entry.mode));
    assert.ok(entry.maxKm > 0);
  }
});

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

test('the ladder is voice only — a data carrier is not listening to a ship', () => {
  assert.ok(MARINE_LADDER.length > 0);
  for (const entry of MARINE_LADDER)
    assert.equal(entry.kind, 'voice', `${entry.id} is in the ladder`);
  for (const entry of MARINE_BANDS.filter((b) => b.kind === 'data'))
    assert.equal(entry.ladder, null, `${entry.id} must stay out of the ladder`);
});

test('the ladder is ordered, and Channel 16 leads it', () => {
  const order = MARINE_LADDER.map((entry) => entry.ladder);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.equal(MARINE_LADDER[0].id, 'vhf-ch16');
  assert.equal(
    MARINE_LADDER.filter((entry) => isLineOfSight(entry)).length,
    1,
    'exactly one line-of-sight band — the rest must carry',
  );
});

test('every band is described well enough to put in front of someone', () => {
  const ids = new Set();
  for (const entry of MARINE_BANDS) {
    assert.ok(!ids.has(entry.id), `${entry.id} is duplicated`);
    ids.add(entry.id);
    assert.ok(entry.label && entry.hint, `${entry.id} explains itself`);
    assert.ok(['voice', 'data'].includes(entry.kind));
    assert.ok(Number.isFinite(entry.freqHz) && entry.freqHz > 0);
    assert.ok(['nbfm', 'usb', 'lsb', 'am'].includes(entry.mode));
    assert.ok(entry.maxKm > 0);
  }
});

test('the GMDSS frequencies are the real ones', () => {
  // Written down so a typo in a distress frequency fails here rather than
  // sending someone to listen to an empty channel.
  const expected = {
    'vhf-ch16': 156_800_000,
    'hf-2182': 2_182_000,
    'hf-4125': 4_125_000,
    'hf-6215': 6_215_000,
    'hf-8291': 8_291_000,
    'hf-12290': 12_290_000,
    'hf-16420': 16_420_000,
    'navtex-518': 518_000,
    'dsc-2187': 2_187_500,
    'dsc-8414': 8_414_500,
  };
  for (const [id, freqHz] of Object.entries(expected))
    assert.equal(marineBand(id)?.freqHz, freqHz, id);
  assert.equal(marineBand('nope'), null);
});

test('a data band says it is data, so no button implies a voice channel', () => {
  for (const entry of MARINE_BANDS.filter((b) => b.kind === 'data'))
    assert.match(
      entry.hint,
      /data|decoder/i,
      `${entry.id} must say it cannot simply be listened to`,
    );
});

test('the panel presets come from the catalog, and stay a short list', () => {
  const presets = marinePresets();
  assert.deepEqual(Object.keys(presets), [...MARINE_PRESET_IDS]);
  assert.ok(
    MARINE_PRESET_IDS.length <= 3,
    'the beginner preset row must not be buried in marine entries',
  );
  for (const [id, preset] of Object.entries(presets)) {
    const source = marineBand(id);
    assert.equal(preset.freqHz, source.freqHz, `${id} frequency matches`);
    assert.equal(preset.mode, source.mode, `${id} mode matches`);
    assert.equal(preset.hint, source.hint, `${id} hint matches`);
    assert.ok(
      preset.freqHz >= preset.band[0] && preset.freqHz <= preset.band[1],
      `${id} sits inside its own band window`,
    );
  }
});

test('the NAVTEX preset is flagged as data and the voice ones are not', () => {
  const presets = marinePresets();
  assert.equal(presets['navtex-518'].data, true);
  assert.equal(presets['vhf-ch16'].data, undefined);
  assert.equal(presets['hf-2182'].data, undefined);
});

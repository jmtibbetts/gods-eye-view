import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARINE_BANDS,
  MARINE_VHF_MAX_KM,
  chooseMarineListen,
  isLineOfSight,
  marineRefusalText,
} from './marine.js';

const band = (id) => MARINE_BANDS.find((entry) => entry.id === id);

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

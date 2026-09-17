import test from 'node:test';
import assert from 'node:assert/strict';
import { SDR_PRESETS, broadcastifyListingFor } from './audioPanels.js';

test('Broadcastify listing follows the state under the view (FIPS ids), front page elsewhere', () => {
  assert.deepEqual(broadcastifyListingFor({ code: 'NV', country: 'US' }), {
    url: 'https://www.broadcastify.com/listen/stid/32',
    label: 'MORE FEEDS: BROADCASTIFY · NEVADA ↗',
  });
  assert.equal(
    broadcastifyListingFor({ code: 'TX', country: 'US' }).url,
    'https://www.broadcastify.com/listen/stid/48',
  );
  assert.equal(
    broadcastifyListingFor({ code: 'ON', country: 'CA' }).url,
    'https://www.broadcastify.com/listen/',
  );
  assert.equal(
    broadcastifyListingFor(null).label,
    'MORE FEEDS: BROADCASTIFY ↗',
  );
});

test('every SDR preset carries a frequency inside its band, a mode and a hint', () => {
  for (const [key, preset] of Object.entries(SDR_PRESETS)) {
    assert.ok(
      preset.freqHz >= preset.band[0] && preset.freqHz <= preset.band[1],
      key,
    );
    assert.ok(
      ['am', 'usb', 'lsb', 'nbfm', 'cw', 'sam'].includes(preset.mode),
      key,
    );
    assert.ok(preset.hint.length > 20, key);
  }
});

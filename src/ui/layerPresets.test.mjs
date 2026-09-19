import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_PRESETS,
  presetIsActive,
  presetPlan,
  presetToastText,
  presetToggleAction,
} from './layerPresets.js';

const probes = (enabled = [], registered = null) => ({
  isEnabled: (id) => enabled.includes(id),
  isRegistered: (id) => (registered ? registered.includes(id) : true),
});

const PRESET = { id: 'p', label: 'P', hint: '', ids: ['a', 'b', 'c'] };

test('every shipped preset names at least two layers', () => {
  assert.ok(LAYER_PRESETS.length >= 1);
  for (const preset of LAYER_PRESETS) {
    assert.ok(preset.ids.length >= 2, `${preset.id} should combine layers`);
    assert.ok(preset.label && preset.hint, `${preset.id} needs label and hint`);
  }
  // The motivating case from the roadmap: radar beneath live flights.
  const stormAir = LAYER_PRESETS.find((p) => p.id === 'storm-and-air');
  assert.ok(stormAir.ids.includes('imagery-radar'));
  assert.ok(stormAir.ids.includes('flights'));
});

test('presetPlan splits layers into to-enable, already-on and missing', () => {
  const plan = presetPlan(PRESET, probes(['b'], ['a', 'b']));
  assert.deepEqual(plan.toEnable, ['a']);
  assert.deepEqual(plan.alreadyOn, ['b']);
  assert.deepEqual(plan.missing, ['c']);
});

test('a preset is active only once every available layer is on', () => {
  assert.equal(presetIsActive(PRESET, probes(['a', 'b'], ['a', 'b'])), true);
  assert.equal(presetIsActive(PRESET, probes(['a'], ['a', 'b'])), false);
  assert.equal(presetIsActive(PRESET, probes([], ['a', 'b'])), false);
});

test('pressing enables the remainder, then turns the whole set off', () => {
  const partly = presetToggleAction(PRESET, probes(['a'], ['a', 'b']));
  assert.equal(partly.action, 'enable');
  assert.deepEqual(partly.ids, ['b']);
  const full = presetToggleAction(PRESET, probes(['a', 'b'], ['a', 'b']));
  assert.equal(full.action, 'disable');
  assert.deepEqual(full.ids, ['a', 'b']);
});

test('a preset with nothing registered reports none rather than failing', () => {
  const action = presetToggleAction(PRESET, probes([], []));
  assert.equal(action.action, 'none');
  assert.deepEqual(action.ids, []);
  assert.equal(action.missing.length, 3);
  assert.match(presetToastText(PRESET, action), /no layers available/);
});

test('toast text counts layers and flags unavailable ones', () => {
  const action = presetToggleAction(PRESET, probes([], ['a', 'b']));
  assert.equal(
    presetToastText(PRESET, action),
    'P: 2 layers on · 1 unavailable',
  );
  const single = presetToggleAction(
    { ...PRESET, ids: ['a'] },
    probes([], ['a']),
  );
  assert.equal(presetToastText(PRESET, single), 'P: 1 layer on');
});

test('a preset that turns on imagery says the 3D basemap is set aside', () => {
  // Imagery overlays borrow the 2D globe from Google 3D. From the IMAGERY
  // panel that trade is announced; from a preset it was silent, and the user
  // saw the 3D vanish behind radar with no explanation.
  const withRadar = { ...PRESET, ids: ['imagery-radar', 'flights'] };
  const on = presetToggleAction(withRadar, probes([]));
  assert.equal(
    presetToastText(withRadar, on),
    'P: 2 layers on · imagery draws on the 2D globe, so Google 3D is set aside',
  );
  const off = presetToggleAction(
    withRadar,
    probes(['imagery-radar', 'flights']),
  );
  assert.equal(presetToastText(withRadar, off), 'P: 2 layers off');
  const noImagery = presetToggleAction(PRESET, probes([]));
  assert.equal(presetToastText(PRESET, noImagery), 'P: 3 layers on');
});

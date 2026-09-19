/**
 * Layer presets (pure): one-press combinations of layers that are only useful
 * together.
 *
 * Reading weather against air traffic is the motivating case — radar alone
 * shows a storm, flights alone show aircraft, and only the two stacked show
 * the diversion. Doing that by hand means finding two or three toggles in
 * different groups, so it rarely gets done. A preset makes it one press, and
 * pressing again puts the globe back the way it was.
 *
 * No DOM and no data manager here: the panel supplies the enabled/registered
 * predicates and performs the writes.
 */

/**
 * @typedef {object} LayerPreset
 * @property {string} id
 * @property {string} label Shown on the button.
 * @property {string} hint Tooltip / aria description.
 * @property {readonly string[]} ids Layer ids the preset turns on.
 */

/** @type {readonly LayerPreset[]} */
export const LAYER_PRESETS = Object.freeze([
  Object.freeze({
    id: 'storm-and-air',
    label: 'STORM + AIR',
    hint: 'Weather radar under live flights, with active NWS warnings — see what the traffic is flying around',
    ids: Object.freeze(['imagery-radar', 'flights', 'weather-alerts']),
  }),
  Object.freeze({
    id: 'severe-weather',
    label: 'SEVERE WX',
    hint: 'Radar, GOES cloud cover, active warnings and the last two days of storm reports',
    ids: Object.freeze([
      'imagery-radar',
      'imagery-goes',
      'weather-alerts',
      'storm-reports',
    ]),
  }),
  Object.freeze({
    id: 'maritime-weather',
    label: 'SEA + WX',
    hint: 'Live AIS vessels under radar and GOES cloud',
    ids: Object.freeze(['ais-live-vessels', 'imagery-radar', 'imagery-goes']),
  }),
  Object.freeze({
    id: 'air-hazards',
    label: 'AIR + HAZARDS',
    hint: 'Live flights over every SIGMET in force and the last minute of lightning — a SIGMET is literally an advisory to aircraft, so the two only mean something together',
    ids: Object.freeze(['flights', 'aviation-hazards', 'lightning']),
  }),
]);

/**
 * Split a preset's layers by what can and cannot be acted on right now.
 *
 * A layer the build did not register (no key, not bundled) is reported as
 * missing rather than silently dropped, so the panel can say why a preset
 * came up short instead of looking broken.
 *
 * @param {LayerPreset} preset
 * @param {{isEnabled:(id:string)=>boolean, isRegistered:(id:string)=>boolean}} probes
 * @returns {{toEnable:string[], alreadyOn:string[], missing:string[]}}
 */
export function presetPlan(preset, { isEnabled, isRegistered } = {}) {
  const toEnable = [];
  const alreadyOn = [];
  const missing = [];
  for (const id of preset?.ids || []) {
    if (isRegistered && !isRegistered(id)) {
      missing.push(id);
      continue;
    }
    if (isEnabled?.(id)) alreadyOn.push(id);
    else toEnable.push(id);
  }
  return { toEnable, alreadyOn, missing };
}

/**
 * A preset reads as active once every available layer in it is on.
 * @param {LayerPreset} preset
 * @param {{isEnabled:(id:string)=>boolean, isRegistered:(id:string)=>boolean}} probes
 * @returns {boolean}
 */
export function presetIsActive(preset, probes) {
  const { toEnable, alreadyOn } = presetPlan(preset, probes);
  return alreadyOn.length > 0 && toEnable.length === 0;
}

/**
 * What a press should do: turn the rest on, or — when it is already fully on —
 * turn the whole set back off.
 * @param {LayerPreset} preset
 * @param {{isEnabled:(id:string)=>boolean, isRegistered:(id:string)=>boolean}} probes
 * @returns {{action:'enable'|'disable'|'none', ids:string[], missing:string[]}}
 */
export function presetToggleAction(preset, probes) {
  const { toEnable, alreadyOn, missing } = presetPlan(preset, probes);
  if (toEnable.length) return { action: 'enable', ids: toEnable, missing };
  if (alreadyOn.length) return { action: 'disable', ids: alreadyOn, missing };
  return { action: 'none', ids: [], missing };
}

/**
 * A short status line for the toast after a press.
 *
 * Three of the four presets turn on an imagery overlay, and imagery can only
 * draw on the 2D globe — the photorealistic 3D basemap is set aside while any
 * overlay is on (see imageryOverlays/surface.js). The IMAGERY panel says so
 * when a sensor is picked there; a preset that does the same thing has to say
 * it too, or the 3D simply disappears with nothing to explain why.
 */
export function presetToastText(preset, { action, ids, missing }) {
  if (action === 'none')
    return `${preset.label}: no layers available in this build`;
  const verb = action === 'enable' ? 'on' : 'off';
  let text = `${preset.label}: ${ids.length} layer${ids.length === 1 ? '' : 's'} ${verb}`;
  if (missing.length) text += ` · ${missing.length} unavailable`;
  if (action === 'enable' && ids.some((id) => id.startsWith('imagery-')))
    text += ' · imagery draws on the 2D globe, so Google 3D is set aside';
  return text;
}

/**
 * What a ship's radio traffic sounds like, and who can hear it.
 *
 * Clicking a vessel should be able to answer "can I listen to this?", and the
 * honest answer depends almost entirely on which band you ask about.
 *
 * VHF Channel 16 is where ships actually call each other and the coast guard,
 * and it is the band people mean by "marine radio". It is also line-of-sight:
 * a receiver has to be on that coast, and only a small minority of the public
 * directory covers above 30 MHz at all. So Channel 16 is offered FIRST and
 * refused quickly when nobody nearby can hear it.
 *
 * The HF marine bands are the opposite. They bounce off the ionosphere, so any
 * receiver in the world may hear them, and most of the directory covers them.
 * They are quieter than they were — GMDSS moved routine traffic to satellite —
 * but 2182 kHz is still the international calling and distress frequency and
 * the ITU ship-to-shore bands still carry coast stations.
 *
 * The ladder is ordered by what the listener would rather hear, not by what is
 * easiest to find, so a coastal ship gets real local chatter and a mid-ocean
 * ship falls back to HF rather than to nothing.
 *
 * PURE module — no Cesium, no DOM, node-testable.
 */

/** Above this, radio is line-of-sight and distance decides everything. */
export const VHF_FLOOR_HZ = 30_000_000;

/**
 * How far a coastal receiver can plausibly hear a ship's VHF.
 *
 * Ship-to-shore VHF is quoted at 20–30 nautical miles, but a web SDR's
 * antenna is usually high and well sited, and the figure that matters is
 * whether the RECEIVER can hear the SHIP. 120 km is generous for that without
 * being a fiction: beyond it the horizon has closed even for a good mast.
 */
export const MARINE_VHF_MAX_KM = 120;

/**
 * The bands to try, best first.
 *
 * `maxKm` is the distance beyond which the band cannot be heard at all;
 * Infinity means propagation, not geometry, decides.
 */
/**
 * The marine bands, and what each one is for.
 *
 * `ladder` is this band's place in the order the ship LISTEN action tries —
 * null means it is never tried automatically. Only VOICE bands are in the
 * ladder, because "listen to this ship" that opens a data carrier and plays
 * warbling is not listening to the ship.
 *
 * `maxKm` is the distance beyond which a band cannot be heard at all;
 * Infinity means propagation, not geometry, decides.
 *
 * Frequencies are the GMDSS distress and calling set: VHF Channel 16, MF
 * 2182 kHz, the five HF radiotelephony frequencies, the MF/HF DSC channels,
 * and NAVTEX.
 */
export const MARINE_BANDS = Object.freeze([
  Object.freeze({
    id: 'vhf-ch16',
    label: 'Channel 16',
    freqHz: 156_800_000,
    mode: 'nbfm',
    kind: 'voice',
    maxKm: MARINE_VHF_MAX_KM,
    ladder: 0,
    hint: 'Ships, harbours and the coast guard calling each other. The busiest marine channel, and the one people mean by marine radio — but VHF is line-of-sight, so it needs a receiver on this coast.',
  }),
  Object.freeze({
    id: 'hf-2182',
    label: '2182 kHz',
    freqHz: 2_182_000,
    mode: 'usb',
    kind: 'voice',
    maxKm: Infinity,
    ladder: 1,
    hint: 'The international MF calling and distress frequency. Carries a long way at night. Quieter than it was — the US Coast Guard stopped guarding it in 2013 and much routine traffic moved to satellite.',
  }),
  Object.freeze({
    id: 'hf-8291',
    label: 'Marine 8 MHz',
    freqHz: 8_291_000,
    mode: 'usb',
    kind: 'voice',
    maxKm: Infinity,
    ladder: 2,
    hint: 'HF distress and calling on the 8 MHz band. The most useful of the HF voice frequencies by day, at ocean distances.',
  }),
  Object.freeze({
    id: 'hf-6215',
    label: 'Marine 6 MHz',
    freqHz: 6_215_000,
    mode: 'usb',
    kind: 'voice',
    maxKm: Infinity,
    ladder: 3,
    hint: 'HF distress and calling on the 6 MHz band. Between 4 and 8 MHz in both range and time of day.',
  }),
  Object.freeze({
    id: 'hf-4125',
    label: 'Marine 4 MHz',
    freqHz: 4_125_000,
    mode: 'usb',
    kind: 'voice',
    maxKm: Infinity,
    ladder: 4,
    hint: 'HF distress and calling on the 4 MHz band. Best at night and at shorter ranges than 8 MHz.',
  }),
  Object.freeze({
    id: 'hf-12290',
    label: 'Marine 12 MHz',
    freqHz: 12_290_000,
    mode: 'usb',
    kind: 'voice',
    maxKm: Infinity,
    ladder: 5,
    hint: 'HF distress and calling on the 12 MHz band. Long daylight paths.',
  }),
  Object.freeze({
    id: 'hf-16420',
    label: 'Marine 16 MHz',
    freqHz: 16_420_000,
    mode: 'usb',
    kind: 'voice',
    maxKm: Infinity,
    ladder: 6,
    hint: 'HF distress and calling on the 16 MHz band. The longest daylight paths, and the quietest.',
  }),
  Object.freeze({
    id: 'navtex-518',
    label: 'NAVTEX',
    freqHz: 518_000,
    mode: 'usb',
    kind: 'data',
    maxKm: Infinity,
    ladder: null,
    hint: 'Navigational warnings and weather, broadcast around the clock on a rotating schedule of coast stations. This is FSK data, not voice: you will hear the carrier, and reading the message needs a decoder this app does not have.',
  }),
  Object.freeze({
    id: 'dsc-2187',
    label: 'DSC 2187.5',
    freqHz: 2_187_500,
    mode: 'usb',
    kind: 'data',
    maxKm: Infinity,
    ladder: null,
    hint: 'The MF digital selective calling channel every GMDSS station guards. Bursts, not conversation, and data rather than voice — a decoder would be needed to read who called whom.',
  }),
  Object.freeze({
    // A placeholder frequency only: LISTEN resolves this to the nearest
    // radiofax station's current one (see weatherfax.js), the way the
    // airband preset resolves to the nearest tower.
    id: 'wefax',
    label: 'Weatherfax',
    freqHz: 8_682_000,
    mode: 'usb',
    kind: 'data',
    maxKm: Infinity,
    ladder: null,
    wefax: true,
    hint: 'Surface analyses, wind and wave charts and ice edges, sent by government stations around the clock. LISTEN picks the station covering the water you are looking at and its frequency for this hour. Data, not voice: the dial sits 1.9 kHz low, which is how radiofax tunes, and drawing the chart needs a decoder this app does not have.',
  }),
  Object.freeze({
    id: 'dsc-8414',
    label: 'DSC 8414.5',
    freqHz: 8_414_500,
    mode: 'usb',
    kind: 'data',
    maxKm: Infinity,
    ladder: null,
    hint: 'The HF digital selective calling channel guarded alongside 2187.5 kHz. Same caveat: bursts of data, not voice.',
  }),
]);

/** The bands the ship LISTEN action tries, in order. Voice only. */
export const MARINE_LADDER = Object.freeze(
  MARINE_BANDS.filter((band) => Number.isFinite(band.ladder)).sort(
    (a, b) => a.ladder - b.ladder,
  ),
);

/** A band by id, or null. */
export const marineBand = (id) =>
  MARINE_BANDS.find((band) => band.id === id) || null;

/** Whether a band is line-of-sight rather than ionospheric. */
export const isLineOfSight = (band) => Number(band?.freqHz) > VHF_FLOOR_HZ;

/**
 * Choose the band and receiver to open for a ship at this position.
 *
 * @param {object} options
 * @param {(band: object) => Array<{distanceKm: number}>} options.receiversFor
 *   Returns candidate receivers covering a band's frequency, nearest first.
 *   Injected so this stays pure and the caller owns the directory.
 * @param {ReadonlyArray<object>} [options.bands]
 * @returns {{band: object, receiver: object}|{band: null, receiver: null,
 *   nearestVhf: object|null}} The chosen pair, or why there is none.
 */
export function chooseMarineListen({ receiversFor, bands = MARINE_LADDER }) {
  let nearestVhf = null;
  for (const band of bands) {
    const [nearest] = receiversFor(band) || [];
    if (!nearest) continue;
    if (isLineOfSight(band) && !nearestVhf) nearestVhf = nearest;
    if (Number(nearest.distanceKm) <= band.maxKm)
      return { band, receiver: nearest };
  }
  return { band: null, receiver: null, nearestVhf };
}

/**
 * The sentence to show when a ship cannot be listened to.
 *
 * Names the distance when one is known, because "no receiver" and "the only
 * receiver is 1,400 km away" are different facts and the second one tells the
 * user their ship is simply out at sea.
 *
 * @param {{nearestVhf?: object|null}} outcome
 * @returns {string}
 */
export function marineRefusalText({ nearestVhf } = {}) {
  if (nearestVhf?.distanceKm)
    return `No receiver can hear this ship. The nearest one covering Channel 16 is ${Math.round(nearestVhf.distanceKm)} km away — beyond line-of-sight — and no HF receiver in the directory covers the marine bands.`;
  return 'No public receiver in the directory can hear this ship: none covers Channel 16 within range, or the marine HF bands at all.';
}

/**
 * The marine bands worth a button in the Receivers panel.
 *
 * Not all ten. The presets there are the beginner set — "what people
 * actually want to hear" — and ten marine entries would bury the rest. These
 * three are the ones that answer a different question each: the busy local
 * channel, the one that carries across an ocean, and the one that is always
 * saying something.
 */
export const MARINE_PRESET_IDS = Object.freeze([
  'vhf-ch16',
  'hf-2182',
  'navtex-518',
  'wefax',
]);

/**
 * Preset entries for the Receivers panel, shaped the way its own presets are
 * and derived from the catalog above so the buttons and the ship's LISTEN
 * ladder can never drift apart.
 *
 * A data band carries `data: true` so the panel can say what it is rather
 * than implying a voice channel.
 *
 * @returns {Record<string, {label:string, freqHz:number, mode:string,
 *   band:[number,number], hint:string, data?: boolean}>}
 */
export function marinePresets() {
  const out = {};
  for (const id of MARINE_PRESET_IDS) {
    const band = marineBand(id);
    if (!band) continue;
    // A band is a window around the frequency, wide enough that the panel's
    // exact-tune box lands inside it: 10 kHz on HF, the marine VHF block up.
    const span = isLineOfSight(band) ? 6_500_000 : 10_000;
    out[id] = {
      label: band.label,
      freqHz: band.freqHz,
      mode: band.mode,
      band: isLineOfSight(band)
        ? [156_000_000, 162_500_000]
        : [Math.max(0, band.freqHz - span), band.freqHz + span],
      hint: band.hint,
      ...(band.kind === 'data' ? { data: true } : {}),
      ...(band.wefax ? { wefax: true } : {}),
    };
  }
  return out;
}

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
export const MARINE_BANDS = Object.freeze([
  Object.freeze({
    id: 'vhf-ch16',
    label: 'Channel 16',
    freqHz: 156_800_000,
    mode: 'nbfm',
    maxKm: MARINE_VHF_MAX_KM,
    hint: 'Ships, harbours and the coast guard calling each other. Needs a receiver on this coast.',
  }),
  Object.freeze({
    id: 'hf-2182',
    label: '2182 kHz',
    freqHz: 2_182_000,
    mode: 'usb',
    maxKm: Infinity,
    hint: 'The international calling and distress frequency on HF. Quiet, but it carries a long way.',
  }),
  Object.freeze({
    id: 'hf-8mhz',
    label: 'Marine 8 MHz',
    freqHz: 8_291_000,
    mode: 'usb',
    maxKm: Infinity,
    hint: 'ITU ship-to-shore band. Best by day at ocean distances.',
  }),
  Object.freeze({
    id: 'hf-4mhz',
    label: 'Marine 4 MHz',
    freqHz: 4_125_000,
    mode: 'usb',
    maxKm: Infinity,
    hint: 'ITU ship-to-shore band. Best at night and at shorter ranges than 8 MHz.',
  }),
]);

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
export function chooseMarineListen({ receiversFor, bands = MARINE_BANDS }) {
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

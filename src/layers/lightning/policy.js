/**
 * Lightning — GOES Geostationary Lightning Mapper flashes.
 *
 * Individual strikes, not a modelled or interpolated field: each dot is one
 * optical flash the satellite actually detected, in the last minute. See
 * server/providers/lightning.js for why this source and not another.
 *
 * COVERAGE IS A HEMISPHERE, AND THE LAYER SAYS SO. GOES is geostationary over
 * the Americas. There is no European, African, Asian or Oceanian coverage from
 * this source, so an empty Europe here means "not observed", not "no
 * lightning". That distinction is the whole reason the layer reports which
 * satellites contributed rather than only a flash count — a reader who cannot
 * tell absence of data from absence of lightning is being misled by omission.
 */

export const LIGHTNING_LAYER_ID = 'lightning';
export const LIGHTNING_ENTITY_PREFIX = 'flash:';

export const LIGHTNING_FLASHES_URL = '/api/lightning/flashes';

/** The upstream lands a file every 20 s; the proxy caches for 30. */
export const LIGHTNING_UPDATE_MS = 30 * 1000;
export const LIGHTNING_FETCH_TIMEOUT_MS = 30_000;

/**
 * Flash colour and size by radiant energy.
 *
 * GLM reports energy in its own scaled integer units, not joules, so these
 * bands are relative rather than physical: they separate the bright flashes
 * from the faint ones on one satellite's scale. They are not a strike-strength
 * measurement and are not labelled as one.
 */
export const ENERGY_BANDS = Object.freeze([
  Object.freeze({
    key: 'faint',
    name: 'Faint',
    min: 0,
    color: '#6ec7ff',
    size: 4,
  }),
  Object.freeze({
    key: 'moderate',
    name: 'Moderate',
    min: 30,
    color: '#9ee6ff',
    size: 5,
  }),
  Object.freeze({
    key: 'bright',
    name: 'Bright',
    min: 120,
    color: '#ffffff',
    size: 7,
  }),
]);

export function energyBand(energy) {
  const n = Number(energy);
  const value = Number.isFinite(n) ? n : 0;
  let band = ENERGY_BANDS[0];
  for (const candidate of ENERGY_BANDS)
    if (value >= candidate.min) band = candidate;
  return band;
}

/** The two contributing satellites, for naming what is and is not observed. */
export const SATELLITE_NAMES = Object.freeze({
  G19: 'GOES-19 East',
  G18: 'GOES-18 West',
});

export function satelliteName(id) {
  return SATELLITE_NAMES[String(id || '').toUpperCase()] || String(id || '');
}

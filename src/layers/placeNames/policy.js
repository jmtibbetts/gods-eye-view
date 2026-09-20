/**
 * What gets named on the globe, and from how far away.
 *
 * A map with no place names is a picture. Google 3D, Esri Satellite and Bing
 * Aerial all ship without a single label — only Bing Labels and OSM carry
 * their own — so on the basemaps this app actually defaults to, nothing on
 * the planet was named at all.
 *
 * The rule here is the one every atlas uses: a name appears at the scale it
 * is useful at and disappears at the scale it is noise at. "Asia" belongs on
 * a view of the hemisphere and nowhere else; a town of nine thousand belongs
 * on a view of one county. The bands below are camera height in metres, and
 * they overlap on purpose — flying down, countries are still named while
 * cities are appearing, because the answer to "where am I" is both.
 *
 * PURE module — no Cesium, node-testable.
 */

export const PLACE_NAMES_LAYER_ID = 'place-names';
export const PLACE_NAMES_OVERLAY_SOURCE_ID = 'place-names';

/** Most labels the overlay host is asked to place at once. */
export const PLACE_NAMES_COHORT_LIMIT = 90;
/** How many of those it is allowed to resolve collisions between. */
export const PLACE_NAMES_COLLISION_CAPACITY = 220;
/** How often the camera is re-read. Cheap when it has not moved. */
export const PLACE_NAMES_VIEW_TICK_MS = 250;

/**
 * The tiers, coarsest first.
 *
 * `minHeight`/`maxHeight` are camera height in metres; a tier is live when
 * the camera is between them. `weight` orders the tiers against each other
 * when the label budget runs out — a continent outranks a sea outranks a
 * town, which is the order you would drop them in if you were drawing this
 * by hand.
 */
export const PLACE_TIERS = Object.freeze([
  Object.freeze({
    id: 'continent',
    label: 'Continents',
    minHeight: 3_000_000,
    maxHeight: Infinity,
    weight: 600,
    accent: '#cfe4ff',
  }),
  Object.freeze({
    id: 'ocean',
    label: 'Oceans',
    minHeight: 1_200_000,
    maxHeight: Infinity,
    weight: 500,
    accent: '#8fc7ff',
  }),
  Object.freeze({
    id: 'country',
    label: 'Countries',
    minHeight: 80_000,
    maxHeight: 14_000_000,
    weight: 400,
    accent: '#e8f1ff',
  }),
  Object.freeze({
    id: 'sea',
    label: 'Seas and gulfs',
    minHeight: 40_000,
    maxHeight: 4_000_000,
    weight: 300,
    accent: '#7fb6e6',
  }),
  Object.freeze({
    id: 'region',
    label: 'Ranges and deserts',
    minHeight: 20_000,
    maxHeight: 2_500_000,
    weight: 200,
    accent: '#d8c9a8',
  }),
  Object.freeze({
    id: 'city',
    label: 'Cities',
    minHeight: 0,
    maxHeight: 6_000_000,
    weight: 100,
    accent: '#ffffff',
  }),
]);

/** The tiers live at this camera height. */
export function tiersForHeight(heightM) {
  const height = Number.isFinite(heightM) ? Math.max(0, heightM) : 0;
  return PLACE_TIERS.filter(
    (tier) => height >= tier.minHeight && height <= tier.maxHeight,
  );
}

/**
 * The coarsest Natural Earth `scalerank` a city may have and still be named
 * at this height. Lower rank is more prominent, so this is a ceiling: at
 * orbit only rank 0 (twenty-seven cities) survives, and by street level
 * everything does.
 *
 * The steps are deliberately coarse. A continuous function would add and drop
 * single towns as you drift, which reads as flicker rather than detail.
 */
export function cityRankCeiling(heightM) {
  const height = Number.isFinite(heightM) ? Math.max(0, heightM) : 0;
  if (height > 3_000_000) return 0;
  if (height > 1_500_000) return 1;
  if (height > 700_000) return 2;
  if (height > 300_000) return 3;
  if (height > 150_000) return 4;
  if (height > 60_000) return 6;
  if (height > 25_000) return 7;
  return 10;
}

/**
 * A national capital is what you look for first in a country you do not
 * know, so it is treated as two ranks more prominent than the file says.
 */
export const CAPITAL_RANK_BONUS = 2;

/** The effective rank a city is judged by. */
export function effectiveCityRank(place) {
  const rank = Number.isFinite(place?.rank) ? place.rank : 10;
  return place?.capital ? rank - CAPITAL_RANK_BONUS : rank;
}

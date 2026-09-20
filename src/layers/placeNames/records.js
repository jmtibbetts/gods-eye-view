import { labelAnchor } from '../../data/placeAnchors.js';
import { pointInRing } from '../../data/naturalEarthRegions.js';
import {
  PLACE_TIERS,
  cityRankCeiling,
  effectiveCityRank,
  tiersForHeight,
} from './policy.js';

/**
 * Turning four data packs into one list of named points, and choosing which
 * of them to draw for a given camera.
 *
 * PURE module — no Cesium, node-testable.
 */

/** The physical-region classes worth a name. The rest are noise at any zoom. */
const REGION_CLASSES = new Set([
  'Range/mtn',
  'Desert',
  'Plateau',
  'Peninsula',
  'Pen/cape',
  'Island group',
  'Plain',
  'Basin',
  'Valley',
  'Tundra',
  'Lowland',
  'Delta',
  'Isthmus',
]);

/** Marine classes that read as a named body of water rather than a nook. */
const SEA_CLASSES = new Set(['sea', 'gulf', 'bay', 'strait', 'channel']);

const tierById = new Map(PLACE_TIERS.map((tier) => [tier.id, tier]));

/**
 * Rank a polygon by how much room its name has.
 *
 * A bigger shape is the more useful name, and clearance — how far the anchor
 * sits from its own edge — is a size measure that already accounts for shape,
 * so a long thin country does not outrank a compact one it could fit inside.
 */
const polygonRank = (clearance) => Math.max(0, Math.round(12 - clearance * 2));

/**
 * Compute label anchors for the polygon tiers. BUILD TIME, not runtime.
 *
 * The pole-of-inaccessibility search costs about a millisecond per shape, and
 * there are a thousand shapes — two and a half seconds on a layer that is on
 * by default is a two and a half second stall at startup. So this runs in
 * `scripts/curate-place-label-anchors.mjs` and the answer is bundled.
 *
 * @param {{countries?: object, regions?: object, marine?: object}} packs
 * @returns {Array<{tier:string,name:string,lon:number,lat:number,rank:number}>}
 */
export function buildPolygonAnchors({
  countries = null,
  regions = null,
  marine = null,
} = {}) {
  const out = [];
  const walk = (pack, pick, tierOf) => {
    for (const feature of pack?.features || []) {
      if (!feature?.name || !pick(feature)) continue;
      const anchor = labelAnchor(feature.polygons);
      if (!anchor) continue;
      out.push({
        tier: tierOf(feature),
        name: feature.name,
        lon: anchor.lon,
        lat: anchor.lat,
        rank: polygonRank(anchor.clearance),
      });
    }
  };
  // Continents and physical regions share one pack, told apart by class.
  walk(
    regions,
    (f) => f.featurecla === 'Continent' || REGION_CLASSES.has(f.featurecla),
    (f) => (f.featurecla === 'Continent' ? 'continent' : 'region'),
  );
  walk(
    marine,
    (f) => f.featurecla === 'ocean' || SEA_CLASSES.has(f.featurecla),
    (f) => (f.featurecla === 'ocean' ? 'ocean' : 'sea'),
  );
  walk(
    countries,
    () => true,
    () => 'country',
  );
  return out;
}

/**
 * Build one tiered place list from the bundled packs.
 *
 * @param {{anchors?: object, places?: object}} packs The precomputed polygon
 *   anchors, and the populated-places pack.
 * @returns {Array<{id:string,name:string,lon:number,lat:number,tier:string,rank:number,priority:number}>}
 */
export function buildPlaces({ anchors = null, places = null } = {}) {
  const out = [];
  const add = (tierId, name, lon, lat, rank, extra = {}) => {
    if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const tier = tierById.get(tierId);
    if (!tier) return;
    out.push({
      id: `${tierId}:${name}`,
      name,
      lon,
      lat,
      tier: tierId,
      rank,
      // Tier first, then prominence within the tier. The overlay host drops
      // from the bottom of this order when the screen runs out of room.
      priority: tier.weight * 100 - Math.min(99, Math.max(0, rank)),
      ...extra,
    });
  };

  for (const anchor of anchors?.features || [])
    add(anchor.tier, anchor.name, anchor.lon, anchor.lat, anchor.rank);

  for (const place of places?.features || [])
    add('city', place.name, place.lon, place.lat, effectiveCityRank(place), {
      capital: place.capital === 1,
      pop: Number.isFinite(place.pop) ? place.pop : null,
    });

  out.sort((a, b) => b.priority - a.priority);
  return out;
}

/**
 * The country the middle of the screen is in.
 *
 * WHY THIS EXISTS. A country is labelled at one point — the pole of
 * inaccessibility — and that point leaves the screen long before the country
 * does. So flying into France made "France" disappear, which is exactly
 * backwards: the closer you get, the more you want to be told where you are.
 *
 * Containment is tested against the real outline rather than a bounding box,
 * because a box says "France" while you are over Belgium, and a label that
 * confidently names the wrong country is worse than no label at all.
 *
 * @param {object} pack The bundled country polygons.
 * @param {number} lon
 * @param {number} lat
 * @returns {string|null} The country's name.
 */
export function countryAt(pack, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  for (const feature of pack?.features || [])
    for (const ring of feature.polygons || [])
      if (pointInRing(ring, lat, lon)) return feature.name;
  return null;
}

/** The middle of a view, with an antimeridian-safe longitude. */
export function viewCenter(view) {
  if (!view) return null;
  const lat = (view.south + view.north) / 2;
  if (view.west <= view.east) return { lon: (view.west + view.east) / 2, lat };
  const span = 360 - view.west + view.east;
  let lon = view.west + span / 2;
  if (lon > 180) lon -= 360;
  return { lon, lat };
}

/** Whether a longitude sits inside a view that may wrap the antimeridian. */
export function lonInView(lon, west, east) {
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

/** Whether a place's own point is on screen. A null view means everywhere. */
function inView(place, view) {
  if (!view) return true;
  if (place.lat < view.south || place.lat > view.north) return false;
  return lonInView(place.lon, view.west, view.east);
}

/**
 * The places worth drawing for one camera.
 *
 * @param {object} options
 * @param {Array} options.places Built by `buildPlaces`.
 * @param {number} options.heightM Camera height in metres.
 * @param {{west:number,south:number,east:number,north:number}|null} options.view
 *   The camera's view rectangle in DEGREES, or null to skip the view filter.
 * @param {number} [options.limit] Most labels to return.
 * @returns {Array} Highest priority first.
 */
export function visiblePlaces({
  places,
  heightM,
  view,
  limit = 90,
  countries = null,
}) {
  const live = new Set(tiersForHeight(heightM).map((tier) => tier.id));
  if (!live.size) return [];
  const cityCeiling = cityRankCeiling(heightM);
  const out = [];
  const seen = new Set();
  // The country under the middle of the screen is named whether or not its
  // own anchor is still on it. It leads the list because it is the answer to
  // the question the whole layer exists for.
  if (live.has('country') && countries) {
    const center = viewCenter(view);
    const name = center ? countryAt(countries, center.lon, center.lat) : null;
    const here = name
      ? (places || []).find(
          (place) => place.tier === 'country' && place.name === name,
        )
      : null;
    if (here) {
      seen.add(here.id);
      out.push(
        // Pinned to the middle of the view, because its own anchor may be a
        // thousand kilometres away and off screen.
        center && !inView(here, view)
          ? { ...here, lon: center.lon, lat: center.lat }
          : here,
      );
    }
  }
  for (const place of places || []) {
    if (!live.has(place.tier) || seen.has(place.id)) continue;
    if (place.tier === 'city' && place.rank > cityCeiling) continue;
    if (!inView(place, view)) continue;
    out.push(place);
    // `places` is pre-sorted by priority, so the first `limit` that pass the
    // filters ARE the top `limit` — no second sort, on a path that runs every
    // time the camera moves.
    if (out.length >= limit) break;
  }
  return out;
}

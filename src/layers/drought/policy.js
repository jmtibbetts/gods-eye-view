/**
 * Drought — the US Drought Monitor's current conditions, and CPC's outlooks.
 *
 * TWO DIFFERENT QUESTIONS, like the river-gauge layer's horizons. The Drought
 * Monitor answers "where is it dry right now", released weekly and valid for a
 * stated Tuesday. The Climate Prediction Center's outlooks answer "where is it
 * expected to get better or worse", which is the one you can still plan around.
 * They are not the same map and are never blended: the chips switch between
 * them and every readout names which one it came from.
 *
 * COLOURS ARE THE SERVICES' OWN, read off their published renderers rather than
 * chosen here, for the same reason the air-quality and severe-outlook bands are:
 * D3 "Extreme" is a defined class with consequences attached, and a shade
 * someone liked would quietly reassign it.
 *
 * NOTE ON `No_Drought`: CPC publishes that class with alpha 0 in its own
 * renderer — the service's way of saying it is not painted. Honoured here by
 * dropping it, so an outlook shows only where something is expected to change.
 */

export const DROUGHT_LAYER_ID = 'drought';
export const DROUGHT_ENTITY_PREFIX = 'drought:';

/** Weekly and monthly products; an hour between refreshes is generous. */
export const DROUGHT_UPDATE_MS = 60 * 60 * 1000;
export const DROUGHT_FETCH_TIMEOUT_MS = 30_000;

const USDM_BASE =
  'https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/US_Drought_Intensity_v1/FeatureServer/3';
const CPC_BASE =
  'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_drought_outlk/MapServer';

/**
 * How far the server may generalize geometry, in degrees.
 *
 * The Drought Monitor's full-resolution polygons are 8.9 MB of GeoJSON — a
 * layer nobody would wait for. Asking the service to generalize to about a
 * kilometre brings that to 0.6 MB with the bands still legible at any zoom
 * this layer is read at. The work happens on ArcGIS's side, so the saving is
 * in transfer rather than in parsing a payload we already paid for.
 */
export const GENERALIZE_DEGREES = 0.01;

/** Degrees of latitude to kilometres. Close enough for an area threshold. */
const KM_PER_DEGREE = 111.32;

/**
 * The smallest polygon part worth drawing, in square kilometres.
 *
 * DERIVED FROM THE GENERALIZATION TOLERANCE, not chosen. A part smaller than
 * the tolerance squared is smaller than the resolution of the geometry the
 * service just handed us — it is below the precision of the measurement, so
 * drawing it asserts detail that is not there.
 *
 * It also happens to be most of the payload: the Drought Monitor arrives as
 * about 2,950 separate parts, of which roughly two thirds are degenerate
 * slivers carrying no measurable area at all. Dropping everything under this
 * threshold keeps about a third of the parts and loses four thousandths of one
 * percent of the drought area. The count that was dropped is reported in the
 * layer's stats rather than being swallowed quietly.
 */
export const MIN_PART_KM2 = (GENERALIZE_DEGREES * KM_PER_DEGREE) ** 2;

/**
 * Approximate area of a flat [lon, lat, …] ring, in square kilometres.
 *
 * The shoelace formula with a cosine correction at the ring's own mean
 * latitude. Good to a few percent over a part this small, which is far more
 * than a drop-or-keep decision needs.
 */
export function ringAreaKm2(flat) {
  if (!Array.isArray(flat) || flat.length < 6) return 0;
  let latSum = 0;
  const count = flat.length / 2;
  for (let i = 1; i < flat.length; i += 2) latSum += flat[i];
  const scale = Math.cos((latSum / count) * (Math.PI / 180));
  let twice = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const j = (i + 2) % flat.length;
    twice += flat[i] * flat[j + 1] - flat[j] * flat[i + 1];
  }
  return Math.abs(twice / 2) * KM_PER_DEGREE * KM_PER_DEGREE * scale;
}

/**
 * Drought Monitor classes, with the service's own colours and severity order.
 *
 * The bands are largely disjoint rather than nested, but they genuinely overlap
 * across roughly a tenth of their area — measured at full resolution, so it is
 * the published data and not a generalization artifact. Drawing ascending by
 * rank is therefore load-bearing: where two classes cover the same ground the
 * worse one must win, or the map reads as better than it is.
 */
export const DROUGHT_CLASSES = Object.freeze([
  Object.freeze({
    code: 0,
    key: 'd0',
    name: 'D0 Abnormally Dry',
    rank: 1,
    color: '#f0dfa6',
    meaning:
      'Going into drought: short-term dryness slowing planting or growth.',
  }),
  Object.freeze({
    code: 1,
    key: 'd1',
    name: 'D1 Moderate Drought',
    rank: 2,
    color: '#edc97b',
    meaning: 'Some damage to crops; streams and reservoirs running low.',
  }),
  Object.freeze({
    code: 2,
    key: 'd2',
    name: 'D2 Severe Drought',
    rank: 3,
    color: '#eb9550',
    meaning: 'Crop or pasture losses likely; water restrictions common.',
  }),
  Object.freeze({
    code: 3,
    key: 'd3',
    name: 'D3 Extreme Drought',
    rank: 4,
    color: '#d94d23',
    meaning: 'Major crop and pasture losses; widespread water shortages.',
  }),
  Object.freeze({
    code: 4,
    key: 'd4',
    name: 'D4 Exceptional Drought',
    rank: 5,
    color: '#990000',
    meaning:
      'Exceptional and widespread losses; shortages in reservoirs, streams and wells.',
  }),
]);

const CLASS_BY_CODE = new Map(DROUGHT_CLASSES.map((c) => [c.code, c]));

/**
 * The class for a `dm` code, or null.
 *
 * Blank, null and boolean codes are rejected BEFORE the numeric conversion,
 * because `Number('')`, `Number(null)` and `Number(false)` are all 0 — which is
 * a valid code. Without this, a feature that arrived with no class at all would
 * be drawn as D0 Abnormally Dry, inventing a drought reading from missing data.
 */
export function droughtClassFor(code) {
  if (code === null || code === undefined || typeof code === 'boolean')
    return null;
  if (typeof code === 'string' && code.trim() === '') return null;
  const n = Number(code);
  return CLASS_BY_CODE.get(Number.isFinite(n) ? n : -1) || null;
}

/**
 * CPC outlook classes, with CPC's own colours.
 *
 * Ranked by how much worse the outlook is, so the ordering rule that governs
 * the Drought Monitor bands governs these too.
 */
export const OUTLOOK_CLASSES = Object.freeze([
  Object.freeze({
    key: 'Removal',
    name: 'Drought removal likely',
    rank: 1,
    color: '#b2ad69',
    meaning: 'Drought is expected to end within the valid period.',
  }),
  Object.freeze({
    key: 'Improvement',
    name: 'Drought remains but improves',
    rank: 2,
    color: '#ded4bc',
    meaning: 'Drought is expected to persist at reduced intensity.',
  }),
  Object.freeze({
    key: 'Persistence',
    name: 'Drought persists',
    rank: 3,
    color: '#9b634a',
    meaning: 'Drought is expected to continue at about its current intensity.',
  }),
  Object.freeze({
    key: 'Development',
    name: 'Drought development likely',
    rank: 4,
    color: '#ffde63',
    meaning: 'Drought is expected to develop where there is none today.',
  }),
]);

const OUTLOOK_BY_KEY = new Map(
  OUTLOOK_CLASSES.map((c) => [c.key.toLowerCase(), c]),
);

/**
 * CPC's `No_Drought` is published with alpha 0 — the service saying it is not
 * painted — so it resolves to null and is dropped rather than drawn as a
 * nationwide blank sheet over everything else.
 */
export function outlookClassFor(value) {
  return (
    OUTLOOK_BY_KEY.get(
      String(value || '')
        .trim()
        .toLowerCase(),
    ) || null
  );
}

/** The three products, switched by the chips on the layer row. */
export const DROUGHT_PRODUCTS = Object.freeze([
  Object.freeze({
    key: 'current',
    chip: 'NOW',
    label: 'Drought Monitor',
    kind: 'monitor',
    blurb: 'Where it is dry right now, released weekly.',
    attribution: 'US Drought Monitor',
  }),
  Object.freeze({
    key: 'monthly',
    chip: 'MONTH',
    label: 'Monthly Outlook',
    kind: 'outlook',
    layerId: 1,
    blurb: 'Where CPC expects drought to change this month.',
    attribution: 'NOAA Climate Prediction Center',
  }),
  Object.freeze({
    key: 'seasonal',
    chip: 'SEASON',
    label: 'Seasonal Outlook',
    kind: 'outlook',
    layerId: 4,
    blurb: 'Where CPC expects drought to change over the season.',
    attribution: 'NOAA Climate Prediction Center',
  }),
]);

export const DEFAULT_PRODUCT = 'current';

export function productFor(key) {
  return (
    DROUGHT_PRODUCTS.find((p) => p.key === key) ||
    DROUGHT_PRODUCTS.find((p) => p.key === DEFAULT_PRODUCT)
  );
}

/**
 * The query for one product.
 *
 * Built with URLSearchParams for the same reason the gauge query is: these
 * carry an offset, an out-SR and a where clause, and hand-encoding them is how
 * a layer silently returns nothing.
 */
export function droughtQueryUrl(product) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields:
      product.kind === 'monitor' ? 'dm,ddate' : 'outlook,fcst_date,target',
    returnGeometry: 'true',
    outSR: '4326',
    // Server-side generalization; see GENERALIZE_DEGREES.
    maxAllowableOffset: String(GENERALIZE_DEGREES),
    f: 'geojson',
  });
  const base =
    product.kind === 'monitor' ? USDM_BASE : `${CPC_BASE}/${product.layerId}`;
  return `${base}/query?${params.toString()}`;
}

/**
 * Tropical cyclones — active storms from the National Hurricane Center, plus
 * the disturbances it is watching for development.
 *
 * WHY BOTH. Named storms are the headline, and for much of the year there are
 * none: NHC's own feed answers "there are no tropical cyclones at this time"
 * more often than not. A layer that is empty two-thirds of the year reads as
 * broken rather than as calm. The Tropical Weather Outlook is the other half
 * of the picture and is almost always populated — the areas being watched,
 * each with its two-day and seven-day formation probability. Together they
 * answer "what is happening, and what might".
 *
 * TWO SOURCES, DELIBERATELY. The storm bulletin (CurrentStorms.json) carries
 * position, intensity, pressure and motion but no geometry. The geometry —
 * forecast cone, track, past track, development regions — lives in NOAA's
 * tropical map service, which speaks GeoJSON. Neither needs a key.
 *
 * ON THE CONE. It is the most misread object in public weather graphics: it
 * shows where the CENTRE is likely to go, about two times in three, and says
 * nothing about how wide the storm is or where its damage reaches. Hazards
 * routinely extend far outside it. The panel says so rather than letting the
 * shape imply a safe outside edge.
 */

export const TROPICAL_LAYER_ID = 'tropical-cyclones';
export const TROPICAL_ENTITY_PREFIX = 'tropical:';

/**
 * Active named storms, through our own proxy.
 *
 * The upstream (nhc.noaa.gov/CurrentStorms.json) is keyless and public but
 * sends no CORS header, so a browser cannot read it — the fetch fails with an
 * opaque TypeError and the storm half of this layer would sit permanently
 * empty while looking merely quiet. NOAA's tropical map service DOES send
 * CORS headers, which is why the outlook loads directly and this does not.
 */
export const NHC_CURRENT_STORMS_URL = '/api/nhc/storms';

/** NOAA tropical map service — geometry for storms and outlook areas. */
export const NHC_MAPSERVER =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';

/** Advisories issue every 6 h, with intermediate ones between; poll modestly. */
export const TROPICAL_UPDATE_MS = 10 * 60 * 1000;
export const TROPICAL_FETCH_TIMEOUT_MS = 20_000;

/**
 * Saffir-Simpson category from one-minute sustained wind in knots.
 * Below 34 kt is a depression; 34-63 a tropical storm; 64+ a hurricane.
 * @param {number} knots
 * @returns {number} 0 for sub-hurricane, else 1-5.
 */
export function saffirSimpson(knots) {
  const kt = Number(knots);
  if (!Number.isFinite(kt) || kt < 64) return 0;
  if (kt < 83) return 1;
  if (kt < 96) return 2;
  if (kt < 113) return 3;
  if (kt < 137) return 4;
  return 5;
}

/**
 * How NHC classifies a system, expanded from its bulletin abbreviation.
 * Unknown codes pass through rather than being guessed at.
 */
export const CLASSIFICATIONS = Object.freeze({
  TD: 'Tropical Depression',
  TS: 'Tropical Storm',
  HU: 'Hurricane',
  MH: 'Major Hurricane',
  STD: 'Subtropical Depression',
  STS: 'Subtropical Storm',
  PTC: 'Potential Tropical Cyclone',
  RM: 'Remnants',
  LO: 'Low',
  DB: 'Disturbance',
  EX: 'Post-Tropical Cyclone',
});

export function classificationLabel(code) {
  const key = String(code || '').toUpperCase();
  return CLASSIFICATIONS[key] || key || 'Unknown';
}

/** Intensity colour, by category. Sub-hurricane systems stay cool-toned. */
export const CATEGORY_COLORS = Object.freeze({
  0: '#5ac8fa',
  1: '#ffd60a',
  2: '#ff9f0a',
  3: '#ff6b35',
  4: '#ff2d55',
  5: '#d6336c',
});

export function categoryColor(knots) {
  return CATEGORY_COLORS[saffirSimpson(knots)] || CATEGORY_COLORS[0];
}

/** Outlook risk bands, as NHC words them. */
export const RISK_COLORS = Object.freeze({
  Low: '#ffd60a',
  Medium: '#ff9f0a',
  High: '#ff2d55',
});

export function riskColor(risk) {
  return RISK_COLORS[String(risk || '').trim()] || '#8e8e93';
}

/**
 * Knots to mph, which is how US advisories state wind and how most readers
 * think about it. Rounded to 5, matching NHC's own convention.
 * @param {number} knots
 * @returns {number}
 */
export function knotsToMph(knots) {
  const kt = Number(knots);
  if (!Number.isFinite(kt)) return Number.NaN;
  return Math.round((kt * 1.15078) / 5) * 5;
}

/** A compass point from degrees, for reporting storm motion. */
export function compassPoint(degrees) {
  const deg = Number(degrees);
  if (!Number.isFinite(deg)) return '';
  const points = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  return points[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * The map-service layer ids that belong to one storm bin (AT1, EP2, …).
 *
 * The service names its layers per bin — "AT1 Forecast Cone" — and renumbers
 * them as storms come and go, so the ids cannot be hardcoded. This reads them
 * from the service's own description.
 *
 * @param {Array<{id:number,name:string}>} layers From MapServer?f=json.
 * @param {string} bin A storm's binNumber.
 * @returns {{cone:?number, forecastTrack:?number, pastTrack:?number, forecastPoints:?number}}
 */
export function layerIdsForBin(layers, bin) {
  const want = String(bin || '').toUpperCase();
  const found = {
    cone: null,
    forecastTrack: null,
    pastTrack: null,
    forecastPoints: null,
  };
  if (!want) return found;
  for (const layer of layers || []) {
    const name = String(layer?.name || '');
    if (!name.toUpperCase().startsWith(`${want} `)) continue;
    const rest = name.slice(want.length + 1).toLowerCase();
    if (rest === 'forecast cone') found.cone = layer.id;
    else if (rest === 'forecast track') found.forecastTrack = layer.id;
    else if (rest === 'past track') found.pastTrack = layer.id;
    else if (rest === 'forecast points') found.forecastPoints = layer.id;
  }
  return found;
}

/** A GeoJSON query URL for one map-service layer. */
export function geoJsonQueryUrl(layerId) {
  return `${NHC_MAPSERVER}/${layerId}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson`;
}

/** Outlook layers, which carry content even with no named storm anywhere. */
export const OUTLOOK_LAYERS = Object.freeze({
  disturbances: 1,
  developmentRegions: 3,
});

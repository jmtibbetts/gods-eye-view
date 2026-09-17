/**
 * Imagery-overlay layers — full-globe raster feeds added on top of the base
 * map as Cesium imagery layers, rather than dots. Three near-real-time feeds:
 *
 *  - VIIRS true-color (NASA GIBS): daily corrected-reflectance imagery,
 *    ~1.5–3.5 h after each overpass.
 *  - GOES-East GeoColor (NASA GIBS): geostationary cloud/weather imagery,
 *    refreshed roughly every 10 minutes ("default" time = latest available).
 *  - Weather radar (RainViewer / NEXRAD + world mosaics): precipitation,
 *    latest frame fetched from RainViewer's index.
 *
 * The provider is a plain tiled raster (UrlTemplateImageryProvider), so this
 * never touches the marker/pick/context machinery — enable() adds an imagery
 * layer, disable() removes it.
 */

export const RAINVIEWER_INDEX_URL =
  'https://api.rainviewer.com/public/weather-maps.json';

/** GIBS best-available WMTS REST endpoint (Web Mercator). */
const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

/** A recent, fully-published UTC date for daily GIBS products (yesterday). */
export function recentGibsDate(now = Date.now()) {
  const d = new Date(now - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Build a GIBS REST tile template for `{z}/{x}/{y}` substitution. */
export function gibsTemplate(layerId, matrixSet, ext, time = 'default') {
  return `${GIBS_BASE}/${layerId}/default/${time}/${matrixSet}/{z}/{y}/{x}.${ext}`;
}

/**
 * The three overlay descriptors. `resolve(fetchImpl)` returns the tile config
 * the layer turns into a Cesium provider; it is async only because radar must
 * look up the latest frame.
 */
export const IMAGERY_OVERLAYS = Object.freeze([
  Object.freeze({
    id: 'imagery-viirs',
    token: '1',
    name: 'Satellite (VIIRS)',
    icon: '🛰️',
    source: 'NASA GIBS',
    attribution:
      'Imagery: NASA EOSDIS GIBS (VIIRS/NOAA-20 Corrected Reflectance)',
    opacity: 1,
    updateInterval: 60 * 60 * 1000,
    async resolve() {
      return {
        url: gibsTemplate(
          'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
          'GoogleMapsCompatible_Level9',
          'jpg',
          recentGibsDate(),
        ),
        maximumLevel: 9,
        credit: 'NASA EOSDIS GIBS',
      };
    },
  }),
  Object.freeze({
    id: 'imagery-goes',
    token: '2',
    name: 'GOES Live Weather',
    icon: '🌀',
    source: 'NASA GIBS / NOAA GOES',
    attribution: 'Imagery: NOAA GOES-East ABI GeoColor via NASA GIBS',
    opacity: 1,
    updateInterval: 10 * 60 * 1000,
    async resolve() {
      return {
        url: gibsTemplate(
          'GOES-East_ABI_GeoColor',
          'GoogleMapsCompatible_Level7',
          'png',
          'default',
        ),
        maximumLevel: 7,
        credit: 'NOAA GOES via NASA GIBS',
      };
    },
  }),
  Object.freeze({
    id: 'imagery-radar',
    token: '3',
    name: 'Weather Radar',
    icon: '🌧️',
    source: 'RainViewer',
    attribution: 'Precipitation radar: RainViewer (NEXRAD + global mosaics)',
    opacity: 0.72,
    updateInterval: 5 * 60 * 1000,
    async resolve(fetchImpl = (...a) => globalThis.fetch(...a)) {
      const response = await fetchImpl(RAINVIEWER_INDEX_URL, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`RainViewer HTTP ${response.status}`);
      const payload = await response.json();
      const config = rainviewerLatest(payload);
      if (!config) throw new Error('RainViewer index had no radar frame');
      return config;
    },
  }),
]);

/**
 * Pick the newest radar frame from a RainViewer index payload and build its
 * tile template. Colour scheme 2 (Universal Blue), smoothed, no snow.
 * @param {any} payload Parsed weather-maps.json.
 * @returns {{url:string, maximumLevel:number, credit:string, frameTime:number}|null}
 */
export function rainviewerLatest(payload) {
  const host = typeof payload?.host === 'string' ? payload.host : '';
  const past = Array.isArray(payload?.radar?.past) ? payload.radar.past : [];
  const nowcast = Array.isArray(payload?.radar?.nowcast)
    ? payload.radar.nowcast
    : [];
  const frame = past.length ? past[past.length - 1] : nowcast[0];
  if (!host || !frame?.path) return null;
  return {
    url: `${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
    maximumLevel: 8,
    credit: 'RainViewer',
    frameTime: Number(frame.time) || null,
  };
}

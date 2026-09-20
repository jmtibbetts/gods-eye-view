/**
 * Imagery-overlay layers — full-globe raster feeds added on top of the base
 * map as Cesium imagery layers, rather than dots.
 *
 * Four slots. Three are GIBS sensor slots whose product is chosen from
 * `catalog.js` at runtime (see IMAGERY_SLOTS there); the fourth is RainViewer
 * radar, which is not GIBS and carries its own resolver.
 *
 * The provider is a plain tiled raster (UrlTemplateImageryProvider), so this
 * never touches the marker/pick/context machinery — enable() adds an imagery
 * layer, disable() removes it.
 *
 * NOTE ON IDS. `imagery-viirs` and `imagery-goes` keep the ids they shipped
 * with, because share links, saved layer state and the combination presets are
 * all written against them and renaming would break every link in the wild.
 * Their DISPLAY names moved with their new breadth: the `imagery-viirs` slot
 * now also carries MODIS and the day/night band, so calling it "VIIRS" in the
 * UI would be a lie. Id is storage; name is what we promise the user.
 *
 * EVERY ONE OF THESE COVERS THE BASEMAP. They are full-globe rasters painted
 * over the photorealistic 3D tileset, so an overlay left on is indistinguishable
 * from "the 3D broke". The panel says so, and only one GIBS slot renders opaque
 * at a time.
 */

export * from './catalog.js';

/** SPC-style keyless radar index; serves `access-control-allow-origin: *`. */
export const RAINVIEWER_INDEX_URL =
  'https://api.rainviewer.com/public/weather-maps.json';

/**
 * The four overlay descriptors. A descriptor with `slotId` draws its tile
 * config from the GIBS catalog and can be switched between sensors; one with
 * its own `resolve` cannot.
 */
export const IMAGERY_OVERLAYS = Object.freeze([
  Object.freeze({
    id: 'imagery-viirs',
    token: '1',
    slotId: 'imagery-viirs',
    name: 'Satellite Imagery',
    icon: '🛰️',
    source: 'NASA GIBS',
    attribution: 'Imagery: NASA EOSDIS GIBS (VIIRS / MODIS)',
    opacity: 1,
    updateInterval: 60 * 60 * 1000,
  }),
  Object.freeze({
    id: 'imagery-goes',
    token: '2',
    slotId: 'imagery-goes',
    name: 'Weather Satellites',
    icon: '🌀',
    source: 'NASA GIBS / NOAA / JMA',
    attribution: 'Imagery: NOAA GOES ABI and JMA Himawari AHI via NASA GIBS',
    opacity: 1,
    updateInterval: 10 * 60 * 1000,
  }),
  Object.freeze({
    id: 'imagery-science',
    token: '7',
    slotId: 'imagery-science',
    name: 'Science Layers',
    icon: '🌡️',
    source: 'NASA GIBS',
    attribution: 'Data: NASA EOSDIS GIBS (GHRSST MUR, MODIS MAIAC, MODIS L3)',
    // Retrieved measurements on a colour ramp rather than a photograph, so
    // they are drawn semi-transparent and imagery underneath still reads.
    opacity: 0.8,
    updateInterval: 60 * 60 * 1000,
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
    // RainViewer's documented maximum is zoom 7. Deeper requests do not fail:
    // they answer HTTP 200 with a grey placeholder tile reading "Zoom Level
    // Not Supported", which Cesium paints as if it were radar — so at zoom 8
    // and beyond every tile on screen became that placeholder, laid at 72%
    // over the basemap. Capping here makes Cesium upsample the last real
    // level instead of asking for tiles that do not exist.
    maximumLevel: 7,
    credit: 'RainViewer',
    frameTime: Number(frame.time) || null,
  };
}

/**
 * The GIBS imagery catalog — every sensor product the three GIBS overlay slots
 * can be switched to.
 *
 * NASA's Global Imagery Browse Services publishes ~1,300 layers from one
 * keyless WMTS endpoint, so adding a sensor is a catalog row rather than a new
 * layer. Each entry here was read off the live GetCapabilities document
 * (epsg3857/best) rather than recalled, then confirmed by decoding a real tile:
 * a wrong identifier does not error, it serves a solid black 200, and a wrong
 * TileMatrixSet serves one at the wrong zoom. `npm run check:imagery` re-probes
 * every product and fails loudly if any comes back blank.
 *
 * CADENCE decides what TIMELINE may do with a product, and how we ask for the
 * live frame:
 *
 *   'daily'   Republished per UTC day with a real archive behind it. TIMELINE
 *             may scrub these, and `archive` is the earliest day GIBS holds.
 *   'rolling' Geostationary feeds refreshed every ~10 minutes, addressed by
 *             timestamp rather than by day. A daily scrubber cannot express
 *             their frames, so TIMELINE leaves them on latest and SAYS so.
 *   'static'  A fixed composite that never moves. Labelled with its vintage so
 *             nobody reads a 2016 mosaic as tonight's pass.
 *   'composite' Assembled on demand from the best scene in a requested window.
 *             Sentinel-2 revisits a spot every few days and is often looking
 *             at cloud when it does, so there is no single "latest frame" to
 *             ask for — the picture you get is the clearest pass within the
 *             window, and its actual date varies by where you are looking.
 *             TIMELINE cannot scrub these, because the thing it would scrub is
 *             a window rather than a day.
 *
 * `sparse` marks a product that does NOT cover the globe on any given day.
 * The swath products image strips as the satellite passes, so most of the
 * world is transparent in any one day's layer and that is correct rather than
 * broken. It matters in two places: the panel says so, instead of letting an
 * empty ocean read as a failed load, and the catalog check relaxes its
 * blank-tile threshold, which would otherwise fail a working product for
 * looking exactly like the thing it is designed to detect absence of.
 *
 * WHY `lagDays` EXISTS. The obvious move is to ask GIBS for the time token
 * `default` and let it pick. That is right for 'rolling' feeds and WRONG for
 * 'daily' ones: for a daily product `default` means TODAY, and today's mosaic
 * is still being stitched from swaths as the satellites come over, so it comes
 * back black for most of the globe. Nor is a single global "yesterday" enough —
 * publication lag differs per product, and asking for a day a product has not
 * published yet returns that same silent black tile rather than an error.
 *
 * So each daily product carries the lag measured against live tiles by stepping
 * back a day at a time until pixels appeared (2026-09-18: swath imagery 1 day,
 * the L4 ocean and aerosol products 2, snow cover 3). Being a day staler than
 * strictly necessary costs nothing; being a day early costs the whole picture.
 * `npm run check:imagery` is what keeps these honest as NASA's schedules move.
 */

/** GIBS best-available WMTS REST endpoint (Web Mercator). */
export const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

/**
 * Ask GIBS for its own newest frame. Only ever used for 'rolling' and 'static'
 * products — see the lagDays note above for why daily products must not.
 */
export const GIBS_LATEST = 'default';

/**
 * How far back `liveTimeFor` may look before giving up. Generous because the
 * OPERA products are not daily mosaics: they are processed swaths that land
 * weeks after the pass, and clamping them to a daily product's lag would ask
 * for a date they have not published.
 */
export const MAX_LAG_DAYS = 40;

/**
 * The time token for a product's LIVE frame.
 *
 * @param {object} product A catalog entry.
 * @param {number|Date} [now] Clock override for tests.
 * @returns {string} `default` for rolling/static feeds, else a UTC `YYYY-MM-DD`.
 */
export function liveTimeFor(product, now = Date.now()) {
  if (!product || product.cadence !== 'daily') return GIBS_LATEST;
  const lag = Number.isFinite(product.lagDays)
    ? Math.min(Math.max(0, product.lagDays), MAX_LAG_DAYS)
    : 1;
  const day = new Date(now instanceof Date ? now.getTime() : now);
  day.setUTCDate(day.getUTCDate() - lag);
  return day.toISOString().slice(0, 10);
}

/**
 * EUMETSAT's EUMETView WMS. Open — no account, no key, no OAuth — and it
 * carries the half of the geostationary ring NASA's GIBS does not: Meteosat
 * over Europe and Africa, the Indian Ocean service, and multimission
 * composites that stitch every geostationary satellite into one global image.
 */
export const EUMETVIEW_WMS = 'https://view.eumetsat.int/geoserver/wms';

/**
 * The time-and-quality parameters a WMS product needs.
 *
 * The two services want opposite things, because they are opposite kinds of
 * feed.
 *
 * EUMETView wants NOTHING. Its `default` resolves to the newest published
 * frame and does so reliably. An earlier version of this file pinned an
 * explicit instant, on the theory that `default` could land in a publication
 * gap — that was a misdiagnosis. The blanks that prompted it were visible-band
 * products over their own night side, which is the instrument working and is
 * now handled by `daylightOnly`. Pinning an instant made things strictly
 * worse: individual frames do go missing, and asking for one that is absent
 * returns HTTP 502, so the "fix" introduced the failure it was meant to
 * prevent. Ask for the default and let the service decide.
 *
 * Sentinel-2 wants a WINDOW. It revisits a given spot every few days and is
 * often looking at cloud when it does, so there is no newest-frame to ask for:
 * it takes a date range and a cloud ceiling, and composites the clearest pass
 * inside them. Asking it for an instant would usually return nothing.
 *
 * @param {object} product A catalog entry with `service` set.
 * @param {number|Date} [now]
 * @returns {Record<string, string>} WMS query parameters.
 */
export function wmsParameters(product, now = Date.now()) {
  if (product?.service !== 'copernicus') return {};
  const ms = now instanceof Date ? now.getTime() : now;
  const days = Number.isFinite(product.windowDays) ? product.windowDays : 90;
  const from = new Date(ms - days * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(ms).toISOString().slice(0, 10);
  const params = { TIME: `${from}/${to}` };
  if (Number.isFinite(product.maxCloudCover))
    params.MAXCC = String(product.maxCloudCover);
  return params;
}

/** True when a product is served by EUMETView WMS rather than GIBS tiles. */
export function isWms(product) {
  return product?.service === 'eumetview' || product?.service === 'copernicus';
}

/** Products that cannot be offered until their credentials are configured. */
export function requiresKey(product) {
  return typeof product?.requiresKey === 'string' ? product.requiresKey : null;
}

/**
 * Metres per pixel of a level-0 tile in Cesium's default WMS tiling scheme
 * (geographic, two 256-pixel tiles of 180° each at level 0), written the way
 * Cesium's ImageryLayer computes its level-zero texel spacing: the equatorial
 * circumference over the pixels across the whole scheme. A geographic tile
 * spans the same degrees north-south as east-west, and a degree of latitude
 * never shrinks, so this is the pixel size a service's limit binds on at any
 * latitude. Level 0 is 78 km/px; each level halves it.
 */
const GEOGRAPHIC_LEVEL0_METERS_PER_PIXEL = (2 * Math.PI * 6378137) / (256 * 2);

/**
 * The zoom floor a product's `maxMetersPerPixel` implies.
 *
 * Sentinel Hub refuses any request coarser than 200 m/px for Sentinel-2 —
 * "Rendering is available up to 200 m/px" — and it refuses it with an IMAGE:
 * a tile whose pixels spell out the error. Cesium cannot tell that from
 * data, so every tile of every Sentinel-2 product, over the whole globe, was
 * a red paragraph until you zoomed in far enough to be under the limit.
 *
 * Two numbers come out, because Cesium keys them differently:
 *   - `minimumLevel` is the provider's: the coarsest IMAGERY level whose
 *     pixels are within the limit. Cesium clamps any coarser choice up to
 *     it, so no request below the limit is ever built.
 *   - `minimumTerrainLevel` is the layer's: the coarsest GLOBE tile the
 *     layer is drawn on at all. Cesium picks a terrain tile's imagery level
 *     by matching texel spacing to the tile's geometric error, and for
 *     geographic-tiled imagery over the terrain this repo uses the two
 *     levels coincide (checked live: level-10 globe tiles carry level-10
 *     Sentinel-2), so the layer is drawn from the same level it may
 *     request. Below that it is simply not drawn, and nothing is asked for.
 *
 * @param {object} product A catalog entry.
 * @returns {{minimumLevel: number, minimumTerrainLevel: number}|null}
 */
export function zoomFloorFor(product) {
  const limit = Number(product?.maxMetersPerPixel);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const minimumLevel = Math.max(
    0,
    Math.ceil(Math.log2(GEOGRAPHIC_LEVEL0_METERS_PER_PIXEL / limit)),
  );
  return { minimumLevel, minimumTerrainLevel: minimumLevel };
}

/**
 * Build a GIBS REST tile template for `{z}/{y}/{x}` substitution.
 * @param {object} product A catalog entry.
 * @param {string} [time] A `YYYY-MM-DD` day, or `default` for latest.
 * @returns {string}
 */
export function gibsTileUrl(product, time = GIBS_LATEST) {
  return `${GIBS_BASE}/${product.gibsId}/default/${time}/${product.matrixSet}/{z}/{y}/{x}.${product.ext}`;
}

/**
 * Clamp a requested archive day into the window a product can actually serve.
 *
 * TIMELINE is deliberately generic: it hands every time-aware layer the same
 * day and lets each decide what to do with it. But the products do not share a
 * window. Snow cover publishes three days behind, so the scrubber's first step
 * back — two days ago — is a day snow cover has not published, and asking for
 * it returns the same silent black tile as a typo'd layer id. Terra reaches
 * back to 2000 while NOAA-20 starts in 2018, so the far end differs too.
 *
 * Clamping here rather than in the scrubber keeps that knowledge next to the
 * product it belongs to, and means a slow product shows its newest real frame
 * instead of nothing.
 *
 * @param {object} product A catalog entry.
 * @param {string} date Requested `YYYY-MM-DD`.
 * @param {number|Date} [now]
 * @returns {string} A day the product can serve.
 */
export function clampToAvailable(product, date, now = Date.now()) {
  if (!product || !date) return date;
  const newest = liveTimeFor(product, now);
  let clamped = date > newest ? newest : date;
  if (product.archive && clamped < product.archive) clamped = product.archive;
  return clamped;
}

/** Products TIMELINE is allowed to move through an archive. */
export function isArchived(product) {
  return product?.cadence === 'daily';
}

const orbital = [
  {
    key: 'viirs-n20-true',
    code: 'a',
    label: 'VIIRS NOAA-20 · True Color',
    platform: 'NOAA-20',
    instrument: 'VIIRS',
    gibsId: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
    matrixSet: 'GoogleMapsCompatible_Level9',
    ext: 'jpg',
    maximumLevel: 9,
    cadence: 'daily',
    lagDays: 1,
    archive: '2018-01-05',
    reveals: 'The planet as your eye would see it, ~13:30 local overpass.',
  },
  {
    key: 'viirs-snpp-true',
    code: 'b',
    label: 'VIIRS Suomi-NPP · True Color',
    platform: 'Suomi-NPP',
    instrument: 'VIIRS',
    gibsId: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    matrixSet: 'GoogleMapsCompatible_Level9',
    ext: 'jpg',
    maximumLevel: 9,
    cadence: 'daily',
    lagDays: 1,
    archive: '2015-11-24',
    reveals:
      'A second true-colour pass ~50 minutes off NOAA-20 — cloud moves between them.',
  },
  {
    key: 'modis-terra-true',
    code: 'c',
    label: 'MODIS Terra · True Color',
    platform: 'Terra',
    instrument: 'MODIS',
    gibsId: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    matrixSet: 'GoogleMapsCompatible_Level9',
    ext: 'jpg',
    maximumLevel: 9,
    cadence: 'daily',
    lagDays: 1,
    archive: '2000-02-24',
    reveals:
      'Morning overpass, and a 26-year archive — the deepest history here.',
  },
  {
    key: 'modis-aqua-true',
    code: 'd',
    label: 'MODIS Aqua · True Color',
    platform: 'Aqua',
    instrument: 'MODIS',
    gibsId: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
    matrixSet: 'GoogleMapsCompatible_Level9',
    ext: 'jpg',
    maximumLevel: 9,
    cadence: 'daily',
    lagDays: 1,
    archive: '2002-07-03',
    reveals: 'Afternoon overpass, back to 2002.',
  },
  {
    key: 'viirs-n20-fire',
    code: 'e',
    label: 'VIIRS · Fire & Burn Scars',
    platform: 'NOAA-20',
    instrument: 'VIIRS M11-I2-I1',
    gibsId: 'VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1',
    matrixSet: 'GoogleMapsCompatible_Level9',
    ext: 'jpg',
    maximumLevel: 9,
    cadence: 'daily',
    lagDays: 1,
    archive: '2018-01-05',
    reveals:
      'Shortwave infrared: active fire burns red, old burn scars go brick, healthy vegetation green.',
  },
  {
    key: 'viirs-n20-snow',
    code: 'f',
    label: 'VIIRS · Snow & Ice',
    platform: 'NOAA-20',
    instrument: 'VIIRS M3-I3-M11',
    gibsId: 'VIIRS_NOAA20_CorrectedReflectance_BandsM3-I3-M11',
    matrixSet: 'GoogleMapsCompatible_Level9',
    ext: 'jpg',
    maximumLevel: 9,
    cadence: 'daily',
    lagDays: 1,
    archive: '2018-01-05',
    reveals:
      'Separates ice from cloud — both white to the eye, cyan vs white here.',
  },
  {
    key: 'modis-terra-721',
    code: 'g',
    label: 'MODIS Terra · Burn & Flood',
    platform: 'Terra',
    instrument: 'MODIS 7-2-1',
    gibsId: 'MODIS_Terra_CorrectedReflectance_Bands721',
    matrixSet: 'GoogleMapsCompatible_Level9',
    ext: 'jpg',
    maximumLevel: 9,
    cadence: 'daily',
    lagDays: 1,
    archive: '2000-02-24',
    reveals:
      'Burn scars and flood extent, with the same 26-year reach as Terra true colour.',
  },
  {
    key: 'viirs-n20-night',
    code: 'h',
    label: 'VIIRS · Day/Night Band',
    platform: 'NOAA-20',
    instrument: 'VIIRS DNB',
    gibsId: 'VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance',
    matrixSet: 'GoogleMapsCompatible_Level8',
    ext: 'png',
    maximumLevel: 8,
    cadence: 'daily',
    lagDays: 1,
    archive: '2024-03-25',
    reveals:
      'Last night, by its own light: cities, gas flares, fishing fleets, fire glow, lightning.',
  },
  {
    key: 'opera-sar',
    code: 'j',
    label: 'Sentinel-1 · Radar (SAR)',
    platform: 'Sentinel-1',
    instrument: 'OPERA RTC SAR',
    gibsId: 'OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1',
    matrixSet: 'GoogleMapsCompatible_Level12',
    ext: 'png',
    maximumLevel: 12,
    cadence: 'daily',
    lagDays: 10,
    archive: '2026-01-05',
    // Radar, not a camera: it makes its own illumination, so cloud and night
    // are irrelevant to it. The catch is coverage - see `sparse`.
    sparse: true,
    reveals:
      'Radar that makes its own light: sees through cloud and works at night, at four times the detail of anything else here.',
  },
  {
    key: 'sentinel2-true',
    code: 'k',
    label: 'Sentinel-2 · True Colour 10 m',
    platform: 'Sentinel-2',
    instrument: 'MSI',
    service: 'copernicus',
    wmsUrl: '/api/copernicus/wms',
    wmsLayer: 'TRUE_COLOR',
    maximumLevel: 15,
    // Sentinel Hub's own ceiling for this collection; see zoomFloorFor().
    maxMetersPerPixel: 200,
    cadence: 'composite',
    // Sentinel-2 is not a daily global mosaic: it revisits a given spot every
    // few days, and the pass is often cloudy. So these ask for the least
    // cloudy scene in a trailing window rather than a single date, which is
    // what makes the picture reliably present instead of reliably empty.
    windowDays: 90,
    maxCloudCover: 20,
    requiresKey: 'copernicus',
    reveals:
      'Individual buildings, field boundaries, single vessels — the least cloudy pass of the last three months.',
  },
  {
    key: 'sentinel2-false',
    code: 'l',
    label: 'Sentinel-2 · False Colour 10 m',
    platform: 'Sentinel-2',
    instrument: 'MSI near-infrared',
    service: 'copernicus',
    wmsUrl: '/api/copernicus/wms',
    wmsLayer: 'FALSE_COLOR',
    maximumLevel: 15,
    // Sentinel Hub's own ceiling for this collection; see zoomFloorFor().
    maxMetersPerPixel: 200,
    cadence: 'composite',
    windowDays: 90,
    maxCloudCover: 20,
    requiresKey: 'copernicus',
    reveals:
      'Living vegetation glows red at this resolution — healthy crop from failed, and burn scars field by field.',
  },
  {
    key: 'sentinel2-swir',
    code: 'm',
    label: 'Sentinel-2 · Shortwave IR 10 m',
    platform: 'Sentinel-2',
    instrument: 'MSI SWIR',
    service: 'copernicus',
    wmsUrl: '/api/copernicus/wms',
    wmsLayer: 'SWIR',
    maximumLevel: 15,
    // Sentinel Hub's own ceiling for this collection; see zoomFloorFor().
    maxMetersPerPixel: 200,
    cadence: 'composite',
    windowDays: 90,
    maxCloudCover: 20,
    requiresKey: 'copernicus',
    reveals:
      'Active fire fronts and soil moisture, at a scale where you can see which side of a road burned.',
  },
  {
    key: 'sentinel2-ndvi',
    code: 'n',
    label: 'Sentinel-2 · Vegetation Index',
    platform: 'Sentinel-2',
    instrument: 'MSI NDVI',
    service: 'copernicus',
    wmsUrl: '/api/copernicus/wms',
    wmsLayer: 'NDVI',
    maximumLevel: 15,
    // Sentinel Hub's own ceiling for this collection; see zoomFloorFor().
    maxMetersPerPixel: 200,
    cadence: 'composite',
    windowDays: 90,
    maxCloudCover: 20,
    requiresKey: 'copernicus',
    reveals:
      'How much living plant matter is there, per 10 m cell — drought stress and irrigation, field by field.',
  },
  {
    key: 'sentinel2-urban',
    code: 'o',
    label: 'Sentinel-2 · Urban 10 m',
    platform: 'Sentinel-2',
    instrument: 'MSI false colour (urban)',
    service: 'copernicus',
    wmsUrl: '/api/copernicus/wms',
    wmsLayer: 'FALSE_COLOR_URBAN',
    maximumLevel: 15,
    // Sentinel Hub's own ceiling for this collection; see zoomFloorFor().
    maxMetersPerPixel: 200,
    cadence: 'composite',
    windowDays: 90,
    maxCloudCover: 20,
    requiresKey: 'copernicus',
    reveals:
      'Built structure separated from bare ground — new construction, runways, and the edge of a city against its soil.',
  },
  {
    key: 'sentinel2-water',
    code: 'p',
    label: 'Sentinel-2 · Water Index',
    platform: 'Sentinel-2',
    instrument: 'MSI NDWI',
    service: 'copernicus',
    wmsUrl: '/api/copernicus/wms',
    wmsLayer: 'NDWI',
    maximumLevel: 15,
    // Sentinel Hub's own ceiling for this collection; see zoomFloorFor().
    maxMetersPerPixel: 200,
    cadence: 'composite',
    windowDays: 90,
    maxCloudCover: 20,
    requiresKey: 'copernicus',
    reveals:
      'Where surface water is, at 10 m — a reservoir falling through a drought, or a river over its banks.',
  },
  {
    key: 'sentinel2-burn',
    code: 'q',
    label: 'Sentinel-2 · Burn Severity',
    platform: 'Sentinel-2',
    instrument: 'MSI NBR',
    service: 'copernicus',
    wmsUrl: '/api/copernicus/wms',
    wmsLayer: 'NBR_RAW',
    maximumLevel: 15,
    // Sentinel Hub's own ceiling for this collection; see zoomFloorFor().
    maxMetersPerPixel: 200,
    cadence: 'composite',
    windowDays: 90,
    maxCloudCover: 20,
    requiresKey: 'copernicus',
    reveals:
      'Not just where it burned but how hard — the normalized burn ratio, which is what post-fire assessments run on.',
  },
  {
    key: 'sentinel2-bathymetric',
    code: 'r',
    label: 'Sentinel-2 · Bathymetric',
    platform: 'Sentinel-2',
    instrument: 'MSI bathymetric',
    service: 'copernicus',
    wmsUrl: '/api/copernicus/wms',
    wmsLayer: 'BATHYMETRIC',
    maximumLevel: 15,
    // Sentinel Hub's own ceiling for this collection; see zoomFloorFor().
    maxMetersPerPixel: 200,
    cadence: 'composite',
    windowDays: 90,
    maxCloudCover: 20,
    requiresKey: 'copernicus',
    reveals:
      'Shallow seafloor through the water column — reefs, sandbars and channels the basemap draws as flat blue.',
  },
  {
    key: 'black-marble',
    code: 'i',
    label: 'Black Marble · 2016',
    platform: 'Suomi-NPP',
    instrument: 'VIIRS DNB composite',
    gibsId: 'VIIRS_Black_Marble',
    matrixSet: 'GoogleMapsCompatible_Level8',
    ext: 'png',
    maximumLevel: 8,
    cadence: 'static',
    archive: null,
    reveals:
      'The cloud-free night-lights mosaic. A 2016 composite — a reference image, not tonight.',
  },
];

const geostationary = [
  {
    key: 'goes-east-geo',
    code: 'a',
    label: 'GOES-East · GeoColor',
    platform: 'GOES-19',
    instrument: 'ABI GeoColor',
    gibsId: 'GOES-East_ABI_GeoColor',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'rolling',
    archive: null,
    reveals:
      'The Americas and Atlantic, refreshed every ~10 minutes. True colour by day, IR cloud by night.',
  },
  {
    key: 'goes-west-geo',
    code: 'b',
    label: 'GOES-West · GeoColor',
    platform: 'GOES-18',
    instrument: 'ABI GeoColor',
    gibsId: 'GOES-West_ABI_GeoColor',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'rolling',
    archive: null,
    reveals:
      'The Pacific half — where the storms that reach the US west coast actually form.',
  },
  {
    key: 'himawari-vis',
    code: 'c',
    label: 'Himawari · Visible',
    platform: 'Himawari-9',
    instrument: 'AHI Band 3',
    gibsId: 'Himawari_AHI_Band3_Red_Visible_1km',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'rolling',
    archive: null,
    // A visible band sees nothing at night. Its disc goes black for half of
    // every day, which is the instrument working, not the feed failing.
    daylightOnly: true,
    reveals:
      'The Asia-Pacific disc the GOES pair cannot see — typhoon alley, daylight only.',
  },
  {
    key: 'goes-east-ir',
    code: 'd',
    label: 'GOES-East · Clean IR',
    platform: 'GOES-19',
    instrument: 'ABI Band 13',
    gibsId: 'GOES-East_ABI_Band13_Clean_Infrared',
    matrixSet: 'GoogleMapsCompatible_Level6',
    ext: 'png',
    maximumLevel: 6,
    cadence: 'rolling',
    archive: null,
    reveals:
      'Cloud-top temperature. Works in full darkness; the coldest tops are the tallest storms.',
  },
  {
    key: 'goes-west-ir',
    code: 'e',
    label: 'GOES-West · Clean IR',
    platform: 'GOES-18',
    instrument: 'ABI Band 13',
    gibsId: 'GOES-West_ABI_Band13_Clean_Infrared',
    matrixSet: 'GoogleMapsCompatible_Level6',
    ext: 'png',
    maximumLevel: 6,
    cadence: 'rolling',
    archive: null,
    reveals: 'The same thermal read on the Pacific side.',
  },
  {
    key: 'himawari-ir',
    code: 'f',
    label: 'Himawari · Clean IR',
    platform: 'Himawari-9',
    instrument: 'AHI Band 13',
    gibsId: 'Himawari_AHI_Band13_Clean_Infrared',
    matrixSet: 'GoogleMapsCompatible_Level6',
    ext: 'png',
    maximumLevel: 6,
    cadence: 'rolling',
    archive: null,
    reveals:
      'Asia-Pacific cloud tops around the clock, unlike the visible band.',
  },
  {
    key: 'goes-east-dust',
    code: 'g',
    label: 'GOES-East · Dust',
    platform: 'GOES-19',
    instrument: 'ABI Dust RGB',
    gibsId: 'GOES-East_ABI_Dust',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'rolling',
    archive: null,
    reveals:
      'Airborne dust and sand that true colour loses against desert — Saharan plumes crossing the Atlantic.',
  },
  {
    key: 'goes-east-fire',
    code: 'h',
    label: 'GOES-East · Fire Temperature',
    platform: 'GOES-19',
    instrument: 'ABI Fire RGB',
    gibsId: 'GOES-East_ABI_FireTemp',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'rolling',
    archive: null,
    reveals:
      'Actively burning fire fronts by radiant temperature, every ~10 minutes rather than per overpass.',
  },
  {
    key: 'goes-east-airmass',
    code: 'i',
    label: 'GOES-East · Air Mass',
    platform: 'GOES-19',
    instrument: 'ABI Air Mass RGB',
    gibsId: 'GOES-East_ABI_Air_Mass',
    matrixSet: 'GoogleMapsCompatible_Level6',
    ext: 'png',
    maximumLevel: 6,
    cadence: 'rolling',
    archive: null,
    reveals:
      'The jet stream made visible: dry stratospheric intrusions red, moist tropical air green.',
  },
];

// EUMETView additions. These complete the geostationary ring: GIBS gives the
// Americas (GOES) and the west Pacific (Himawari), and everything between —
// Europe, Africa, the Indian Ocean — was a blind spot until these.
const geostationaryEumetview = [
  {
    key: 'georing-natural',
    code: 'j',
    label: 'Geo Ring · Natural Colour',
    platform: 'GOES + Meteosat + Himawari',
    instrument: 'Multimission composite',
    service: 'eumetview',
    wmsLayer: 'mumi:wideareacoverage_rgb_natural',
    maximumLevel: 7,
    cadence: 'rolling',
    scanMinutes: 180,
    lagMinutes: 240,
    reveals:
      'Every geostationary satellite stitched into one image — the whole belt at once, with no blind side.',
  },
  {
    key: 'georing-ir',
    code: 'k',
    label: 'Geo Ring · Infrared',
    platform: 'GOES + Meteosat + Himawari',
    instrument: 'Multimission IR10.8',
    service: 'eumetview',
    wmsLayer: 'mumi:worldcloudmap_ir108',
    maximumLevel: 7,
    cadence: 'rolling',
    scanMinutes: 180,
    lagMinutes: 240,
    reveals:
      'The same global ring read thermally, so the night half is as visible as the day half.',
  },
  {
    key: 'meteosat-geocolour',
    code: 'l',
    label: 'Meteosat · GeoColor',
    platform: 'Meteosat Third Generation',
    instrument: 'FCI GeoColor',
    service: 'eumetview',
    wmsLayer: 'mtg_fd:rgb_geocolour',
    maximumLevel: 7,
    cadence: 'rolling',
    scanMinutes: 10,
    lagMinutes: 30,
    reveals:
      'Europe, Africa and the Atlantic every ten minutes — the GOES view, for the other side of the world.',
  },
  {
    key: 'meteosat-truecolour',
    code: 'm',
    label: 'Meteosat · True Colour',
    platform: 'Meteosat Third Generation',
    instrument: 'FCI',
    service: 'eumetview',
    wmsLayer: 'mtg_fd:rgb_truecolour',
    maximumLevel: 7,
    cadence: 'rolling',
    scanMinutes: 10,
    lagMinutes: 30,
    daylightOnly: true,
    reveals:
      'Unprocessed daylight colour over Europe and Africa, without GeoColor’s night-time substitution.',
  },
  {
    key: 'meteosat-io',
    code: 'n',
    label: 'Meteosat · Indian Ocean',
    platform: 'Meteosat Second Generation',
    instrument: 'SEVIRI natural colour',
    service: 'eumetview',
    wmsLayer: 'msg_iodc:rgb_natural',
    maximumLevel: 7,
    cadence: 'rolling',
    scanMinutes: 15,
    lagMinutes: 45,
    daylightOnly: true,
    reveals:
      'The Indian Ocean service — monsoon, Arabian Sea cyclones, and the ocean neither GOES nor Himawari sees well.',
  },
  {
    key: 'meteosat-io-ir',
    code: 'o',
    label: 'Meteosat · Indian Ocean IR',
    platform: 'Meteosat Second Generation',
    instrument: 'SEVIRI IR10.8',
    service: 'eumetview',
    wmsLayer: 'msg_iodc:ir108',
    maximumLevel: 7,
    cadence: 'rolling',
    scanMinutes: 15,
    lagMinutes: 45,
    reveals:
      'The same disc around the clock — cyclone structure over the Indian Ocean at night, when the colour view is dark.',
  },
  {
    key: 'meteosat-ash',
    code: 'p',
    label: 'Meteosat · Volcanic Ash',
    platform: 'Meteosat',
    instrument: 'SEVIRI Ash RGB',
    service: 'eumetview',
    wmsLayer: 'msg_fes:rgb_ash',
    maximumLevel: 7,
    cadence: 'rolling',
    scanMinutes: 15,
    lagMinutes: 45,
    reveals:
      'Separates a volcanic ash plume from ordinary cloud — the thing that actually grounds aircraft, seen directly.',
  },
];

const science = [
  {
    key: 'sst',
    code: 'a',
    label: 'Sea Surface Temperature',
    platform: 'Multi-sensor L4',
    instrument: 'GHRSST MUR',
    gibsId: 'GHRSST_L4_MUR_Sea_Surface_Temperature',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'daily',
    lagDays: 2,
    archive: '2002-06-01',
    reveals:
      'Gulf Stream, upwelling, and the warm water that feeds hurricanes.',
    opacity: 0.8,
  },
  {
    key: 'sst-anomaly',
    code: 'b',
    label: 'SST Anomaly',
    platform: 'Multi-sensor L4',
    instrument: 'GHRSST MUR',
    gibsId: 'GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'daily',
    lagDays: 2,
    archive: '2002-06-01',
    reveals:
      'Departure from normal rather than absolute temperature — where El Niño and marine heatwaves show.',
    opacity: 0.8,
  },
  {
    key: 'aerosol',
    code: 'c',
    label: 'Aerosol Optical Depth',
    platform: 'Terra + Aqua',
    instrument: 'MODIS MAIAC',
    gibsId: 'MODIS_Combined_MAIAC_L2G_AerosolOpticalDepth',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'daily',
    lagDays: 2,
    archive: '2000-02-24',
    reveals:
      'How much smoke, dust and haze is in the column — wildfire plumes downwind of the fire.',
    opacity: 0.75,
  },
  {
    key: 'snow-cover',
    code: 'd',
    label: 'Snow Cover',
    platform: 'Terra',
    instrument: 'MODIS NDSI',
    gibsId: 'MODIS_Terra_L3_NDSI_Snow_Cover_Daily',
    matrixSet: 'GoogleMapsCompatible_Level8',
    ext: 'png',
    maximumLevel: 8,
    cadence: 'daily',
    lagDays: 3,
    archive: '2000-02-24',
    reveals:
      'Snow separated from cloud by index rather than by brightness. Runs ~3 days behind.',
    opacity: 0.8,
  },
  {
    key: 'land-temp',
    code: 'e',
    label: 'Land Surface Temperature',
    platform: 'Terra',
    instrument: 'MODIS LST',
    gibsId: 'MODIS_Terra_Land_Surface_Temp_Day',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'daily',
    lagDays: 1,
    archive: '2000-02-24',
    reveals:
      'Ground temperature, not air temperature — urban heat islands read hot.',
    opacity: 0.8,
  },
  {
    key: 'flood-extent',
    code: 'g',
    label: 'Flood & Surface Water',
    platform: 'Sentinel-1',
    instrument: 'OPERA DSWx',
    gibsId: 'OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1',
    matrixSet: 'GoogleMapsCompatible_Level12',
    ext: 'png',
    maximumLevel: 12,
    cadence: 'daily',
    lagDays: 23,
    archive: '2025-10-24',
    sparse: true,
    reveals:
      'Where water is standing that normally is not — flood extent mapped by radar, so cloud over the flood does not hide it.',
    opacity: 0.85,
  },
  {
    key: 'sea-ice',
    code: 'f',
    label: 'Sea Ice Concentration',
    platform: 'Multi-sensor L4',
    instrument: 'GHRSST MUR',
    gibsId: 'GHRSST_L4_MUR_Sea_Ice_Concentration',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    cadence: 'daily',
    lagDays: 2,
    archive: '2002-06-01',
    reveals:
      'Polar pack-ice extent, and the Northwest Passage opening and closing with the season.',
    opacity: 0.8,
  },
];

function freezeGroup(products) {
  return Object.freeze(products.map((p) => Object.freeze({ ...p })));
}

/**
 * The three GIBS slots. Each owns a product list and a default selection; the
 * slot ids are the existing layer ids, kept stable so share links, saved layer
 * state and the combination presets written against them keep working. Their
 * DISPLAY names moved with their new breadth — the `imagery-viirs` slot can
 * now carry MODIS, so calling it "VIIRS" in the UI would be a lie.
 */
export const IMAGERY_SLOTS = Object.freeze({
  'imagery-viirs': Object.freeze({
    group: 'orbital',
    heading: 'ORBITAL IMAGERY',
    blurb:
      'Polar-orbiting sensors. One mosaic per day, built from swaths as each satellite passes overhead.',
    products: freezeGroup(orbital),
    defaultKey: 'viirs-n20-true',
  }),
  'imagery-goes': Object.freeze({
    group: 'geostationary',
    heading: 'GEOSTATIONARY WEATHER',
    blurb:
      'Parked over one spot, staring. Refreshed every ~10 minutes — this is what moves while you watch. NASA covers the Americas and the west Pacific; EUMETSAT covers everything between.',
    products: freezeGroup([...geostationary, ...geostationaryEumetview]),
    defaultKey: 'goes-east-geo',
  }),
  'imagery-science': Object.freeze({
    group: 'science',
    heading: 'MEASURED SCIENCE',
    blurb:
      'Not photographs — retrieved measurements on a colour ramp. Semi-transparent so imagery beneath still reads.',
    products: freezeGroup(science),
    defaultKey: 'sst',
  }),
});

/** Slot ids in the order the IMAGERY panel lists them. */
export const IMAGERY_SLOT_ORDER = Object.freeze(Object.keys(IMAGERY_SLOTS));

/** Every product, flattened, for validation and tests. */
export const ALL_IMAGERY_PRODUCTS = Object.freeze(
  Object.values(IMAGERY_SLOTS).flatMap((slot) => slot.products),
);

/**
 * Look up one product inside a slot, falling back to the slot default so an
 * unknown key from an old link degrades to a working picture rather than a
 * blank globe.
 * @param {string} slotId
 * @param {string|null} key
 * @returns {object|null}
 */
export function productFor(slotId, key) {
  const slot = IMAGERY_SLOTS[slotId];
  if (!slot) return null;
  return (
    slot.products.find((p) => p.key === key) ||
    slot.products.find((p) => p.key === slot.defaultKey) ||
    slot.products[0] ||
    null
  );
}

/** Enum values and single-char URL codes for one slot, for the state codec. */
export function slotCodec(slotId) {
  const slot = IMAGERY_SLOTS[slotId];
  if (!slot) return { values: [], codes: {}, defaultKey: null };
  return {
    values: slot.products.map((p) => p.key),
    codes: Object.fromEntries(slot.products.map((p) => [p.key, p.code])),
    defaultKey: slot.defaultKey,
  };
}

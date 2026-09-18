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

/** How far back `liveTimeFor` may look before giving up. */
export const MAX_LAG_DAYS = 10;

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
      'Parked over one spot, staring. Refreshed every ~10 minutes — this is what moves while you watch.',
    products: freezeGroup(geostationary),
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

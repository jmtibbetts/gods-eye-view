/**
 * The imaging fleet — which satellites carry a sensor whose pictures this
 * app can actually show, and what that sensor is.
 *
 * WHAT THIS IS NOT. No public satellite takes commands from anyone but its
 * operator. NASA, NOAA, ESA and EUMETSAT decide what their instruments do,
 * and what they publish arrives minutes (geostationary) to a day (polar)
 * after capture. So there is no "point the camera" here, and nothing that
 * pretends to be one. What a SENSORS panel controls is which of a
 * satellite's published bands and products the globe draws, switched live;
 * what it shows is the satellite moving, the ground its instrument is
 * sweeping right now, and the newest pass that instrument has published.
 *
 * Each entry is keyed by NORAD catalogue number so it survives renames, and
 * names the platform string(s) the imagery catalog files its products under.
 * Products are DERIVED from that catalog at lookup time, never listed here,
 * so a sensor added to the catalog appears on its satellite without a second
 * edit — and a platform string that drifts fails a test rather than showing
 * a satellite with no bands.
 *
 * `swathKm` is the instrument's cross-track ground coverage for a polar
 * orbiter, or null for a geostationary imager that sees a whole disk.
 * `reveals` is what the eye should look for in that sensor's pictures.
 */
export const IMAGING_PLATFORMS = Object.freeze([
  // ---- Polar orbiters: sun-synchronous, every spot seen at the same local time
  Object.freeze({
    norad: 43013,
    name: 'NOAA-20',
    operator: 'NOAA / NASA (JPSS-1)',
    orbit: 'polar',
    platforms: Object.freeze(['NOAA-20']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'VIIRS',
        fullName: 'Visible Infrared Imaging Radiometer Suite',
        swathKm: 3060,
        resolution: '375 m (I-bands) · 750 m (M-bands)',
        bands: '22 bands, 0.4–12.5 µm, plus the day/night band',
        reveals:
          'A full-Earth picture every day; smoke, dust, snow, and the lights of the night side.',
      }),
    ]),
    note: 'Afternoon orbit — crosses the equator northbound at ~13:30 local.',
  }),
  Object.freeze({
    norad: 37849,
    name: 'Suomi NPP',
    operator: 'NOAA / NASA',
    orbit: 'polar',
    platforms: Object.freeze(['Suomi-NPP']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'VIIRS',
        fullName: 'Visible Infrared Imaging Radiometer Suite',
        swathKm: 3060,
        resolution: '375 m (I-bands) · 750 m (M-bands)',
        bands: '22 bands, 0.4–12.5 µm, plus the day/night band',
        reveals:
          'The same instrument as NOAA-20, fifty minutes ahead of it in the same orbit.',
      }),
    ]),
    note: 'Afternoon orbit, ~50 minutes ahead of NOAA-20.',
  }),
  Object.freeze({
    norad: 25994,
    name: 'Terra',
    operator: 'NASA',
    orbit: 'polar',
    platforms: Object.freeze(['Terra', 'Terra + Aqua']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'MODIS',
        fullName: 'Moderate Resolution Imaging Spectroradiometer',
        swathKm: 2330,
        resolution: '250 m · 500 m · 1 km by band',
        bands: '36 bands, 0.4–14.4 µm',
        reveals:
          'Morning-light true colour, burn scars and floods in the 7-2-1 composite, land temperature and snow.',
      }),
    ]),
    note: 'Morning orbit — crosses the equator southbound at ~10:30 local. Imaging since 2000.',
  }),
  Object.freeze({
    norad: 27424,
    name: 'Aqua',
    operator: 'NASA',
    orbit: 'polar',
    platforms: Object.freeze(['Aqua', 'Terra + Aqua']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'MODIS',
        fullName: 'Moderate Resolution Imaging Spectroradiometer',
        swathKm: 2330,
        resolution: '250 m · 500 m · 1 km by band',
        bands: '36 bands, 0.4–14.4 µm',
        reveals:
          "Afternoon-light true colour — Terra's twin, three hours later in the day.",
      }),
    ]),
    note: 'Afternoon orbit — crosses the equator northbound at ~13:30 local.',
  }),
  Object.freeze({
    norad: 39634,
    name: 'Sentinel-1A',
    operator: 'ESA / Copernicus',
    orbit: 'polar',
    platforms: Object.freeze(['Sentinel-1']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'C-SAR',
        fullName: 'C-band Synthetic Aperture Radar',
        swathKm: 250,
        resolution: '5 × 20 m (interferometric wide swath)',
        bands: 'C-band radar, 5.4 GHz — makes its own illumination',
        reveals:
          'Ground through cloud and at night; flooding, ships, and terrain texture.',
      }),
    ]),
    note: 'Radar, so daylight and cloud do not matter. Published in swaths, days behind.',
  }),
  Object.freeze({
    norad: 62261,
    name: 'Sentinel-1C',
    operator: 'ESA / Copernicus',
    orbit: 'polar',
    platforms: Object.freeze(['Sentinel-1']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'C-SAR',
        fullName: 'C-band Synthetic Aperture Radar',
        swathKm: 250,
        resolution: '5 × 20 m (interferometric wide swath)',
        bands: 'C-band radar, 5.4 GHz — makes its own illumination',
        reveals:
          "Sentinel-1A's partner in the same orbital plane, halving the revisit.",
      }),
    ]),
    note: 'Radar, so daylight and cloud do not matter. Published in swaths, days behind.',
  }),
  Object.freeze({
    norad: 40697,
    name: 'Sentinel-2A',
    operator: 'ESA / Copernicus',
    orbit: 'polar',
    platforms: Object.freeze(['Sentinel-2']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'MSI',
        fullName: 'MultiSpectral Instrument',
        swathKm: 290,
        resolution: '10 m · 20 m · 60 m by band',
        bands: '13 bands, 0.44–2.2 µm',
        reveals:
          'Individual buildings, field boundaries, single vessels — the clearest pass of the last three months.',
      }),
    ]),
    note: 'Needs a Copernicus key. Crosses the equator at ~10:30 local; revisits a spot every five days with its siblings.',
  }),
  Object.freeze({
    norad: 42063,
    name: 'Sentinel-2B',
    operator: 'ESA / Copernicus',
    orbit: 'polar',
    platforms: Object.freeze(['Sentinel-2']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'MSI',
        fullName: 'MultiSpectral Instrument',
        swathKm: 290,
        resolution: '10 m · 20 m · 60 m by band',
        bands: '13 bands, 0.44–2.2 µm',
        reveals:
          'The same instrument as Sentinel-2A, on the opposite side of the orbit.',
      }),
    ]),
    note: 'Needs a Copernicus key. Crosses the equator at ~10:30 local.',
  }),
  Object.freeze({
    norad: 60989,
    name: 'Sentinel-2C',
    operator: 'ESA / Copernicus',
    orbit: 'polar',
    platforms: Object.freeze(['Sentinel-2']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'MSI',
        fullName: 'MultiSpectral Instrument',
        swathKm: 290,
        resolution: '10 m · 20 m · 60 m by band',
        bands: '13 bands, 0.44–2.2 µm',
        reveals: 'The newest of the three, replacing Sentinel-2A in its slot.',
      }),
    ]),
    note: 'Needs a Copernicus key. Crosses the equator at ~10:30 local.',
  }),
  // ---- Polar orbiters this app has no product for yet: still worth watching
  Object.freeze({
    norad: 54234,
    name: 'NOAA-21',
    operator: 'NOAA / NASA (JPSS-2)',
    orbit: 'polar',
    platforms: Object.freeze([]),
    instruments: Object.freeze([
      Object.freeze({
        name: 'VIIRS',
        fullName: 'Visible Infrared Imaging Radiometer Suite',
        swathKm: 3060,
        resolution: '375 m (I-bands) · 750 m (M-bands)',
        bands: '22 bands, 0.4–12.5 µm, plus the day/night band',
        reveals:
          'The third VIIRS in orbit; its products are not in this catalog yet.',
      }),
    ]),
    note: 'Afternoon orbit, sharing the plane with NOAA-20 and Suomi NPP.',
    link: 'https://www.nesdis.noaa.gov/our-satellites/currently-flying/joint-polar-satellite-system',
  }),
  Object.freeze({
    norad: 39084,
    name: 'Landsat 8',
    operator: 'NASA / USGS',
    orbit: 'polar',
    platforms: Object.freeze([]),
    instruments: Object.freeze([
      Object.freeze({
        name: 'OLI · TIRS',
        fullName: 'Operational Land Imager · Thermal Infrared Sensor',
        swathKm: 185,
        resolution: '15 m pan · 30 m multispectral · 100 m thermal',
        bands: '11 bands, 0.43–12.5 µm',
        reveals:
          'The fifty-year land record; scenes are served by USGS EarthExplorer, not here.',
      }),
    ]),
    note: 'Sixteen-day revisit, offset eight days from Landsat 9.',
    link: 'https://earthexplorer.usgs.gov',
  }),
  Object.freeze({
    norad: 49260,
    name: 'Landsat 9',
    operator: 'NASA / USGS',
    orbit: 'polar',
    platforms: Object.freeze([]),
    instruments: Object.freeze([
      Object.freeze({
        name: 'OLI-2 · TIRS-2',
        fullName: 'Operational Land Imager 2 · Thermal Infrared Sensor 2',
        swathKm: 185,
        resolution: '15 m pan · 30 m multispectral · 100 m thermal',
        bands: '11 bands, 0.43–12.5 µm',
        reveals:
          "Landsat 8's twin; scenes are served by USGS EarthExplorer, not here.",
      }),
    ]),
    note: 'Sixteen-day revisit, offset eight days from Landsat 8.',
    link: 'https://earthexplorer.usgs.gov',
  }),
  Object.freeze({
    norad: 41335,
    name: 'Sentinel-3A',
    operator: 'ESA / EUMETSAT / Copernicus',
    orbit: 'polar',
    platforms: Object.freeze([]),
    instruments: Object.freeze([
      Object.freeze({
        name: 'OLCI · SLSTR',
        fullName:
          'Ocean and Land Colour Instrument · Sea and Land Surface Temperature Radiometer',
        swathKm: 1270,
        resolution: '300 m (OLCI) · 500 m–1 km (SLSTR)',
        bands: '21 optical bands + 9 thermal/SWIR',
        reveals:
          'Ocean colour and surface temperature; not in this catalog yet.',
      }),
    ]),
    note: 'Crosses the equator at ~10:00 local.',
    link: 'https://sentinels.copernicus.eu/web/sentinel/missions/sentinel-3',
  }),
  // ---- Geostationary imagers: parked over one longitude, a whole disk at once
  Object.freeze({
    norad: 60133,
    name: 'GOES-19 (East)',
    operator: 'NOAA',
    orbit: 'geostationary',
    platforms: Object.freeze(['GOES-19', 'GOES + Meteosat + Himawari']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'ABI',
        fullName: 'Advanced Baseline Imager',
        swathKm: null,
        resolution: '0.5 km visible · 2 km infrared',
        bands: '16 bands, 0.47–13.3 µm; a full disk every 10 minutes',
        reveals:
          'Weather over the Americas as it happens — cloud, dust, fire temperature, air mass.',
      }),
      Object.freeze({
        name: 'GLM',
        fullName: 'Geostationary Lightning Mapper',
        swathKm: null,
        resolution: '8 km',
        bands: '777.4 nm, 500 frames a second',
        reveals:
          'Every optical lightning flash in view — the Lightning layer draws them.',
        // Not imagery: this instrument's product is a data layer.
        layerId: 'lightning',
        layerLabel: 'LIGHTNING LAYER',
      }),
    ]),
    note: 'Parked at 75.2°W. Its ten-minute frames are the closest thing here to live.',
  }),
  Object.freeze({
    norad: 51850,
    name: 'GOES-18 (West)',
    operator: 'NOAA',
    orbit: 'geostationary',
    platforms: Object.freeze(['GOES-18', 'GOES + Meteosat + Himawari']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'ABI',
        fullName: 'Advanced Baseline Imager',
        swathKm: null,
        resolution: '0.5 km visible · 2 km infrared',
        bands: '16 bands, 0.47–13.3 µm; a full disk every 10 minutes',
        reveals:
          'The Pacific and the American West, refreshed every ten minutes.',
      }),
      Object.freeze({
        name: 'GLM',
        fullName: 'Geostationary Lightning Mapper',
        swathKm: null,
        resolution: '8 km',
        bands: '777.4 nm, 500 frames a second',
        reveals:
          'Every optical lightning flash in view — the Lightning layer draws them.',
        // Not imagery: this instrument's product is a data layer.
        layerId: 'lightning',
        layerLabel: 'LIGHTNING LAYER',
      }),
    ]),
    note: 'Parked at 137.0°W.',
  }),
  Object.freeze({
    norad: 41836,
    name: 'Himawari-9',
    operator: 'JMA',
    orbit: 'geostationary',
    platforms: Object.freeze(['Himawari-9', 'GOES + Meteosat + Himawari']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'AHI',
        fullName: 'Advanced Himawari Imager',
        swathKm: null,
        resolution: '0.5 km visible · 2 km infrared',
        bands: '16 bands, 0.47–13.3 µm; a full disk every 10 minutes',
        reveals:
          'East Asia, Australia and the western Pacific — typhoons in particular.',
      }),
    ]),
    note: 'Parked at 140.7°E.',
  }),
  Object.freeze({
    norad: 54743,
    name: 'Meteosat-12 (MTG-I1)',
    operator: 'EUMETSAT',
    orbit: 'geostationary',
    platforms: Object.freeze([
      'Meteosat Third Generation',
      'Meteosat',
      'GOES + Meteosat + Himawari',
    ]),
    instruments: Object.freeze([
      Object.freeze({
        name: 'FCI',
        fullName: 'Flexible Combined Imager',
        swathKm: null,
        resolution: '0.5 km visible · 1–2 km infrared',
        bands: '16 bands, 0.44–13.3 µm; a full disk every 10 minutes',
        reveals:
          'Europe, Africa and the Atlantic in true colour — the newest imager in the ring.',
      }),
    ]),
    note: 'Parked at 0°. First of the third generation.',
  }),
  Object.freeze({
    norad: 40732,
    name: 'Meteosat-11 (MSG-4)',
    operator: 'EUMETSAT',
    orbit: 'geostationary',
    platforms: Object.freeze(['Meteosat', 'GOES + Meteosat + Himawari']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'SEVIRI',
        fullName: 'Spinning Enhanced Visible and Infrared Imager',
        swathKm: null,
        resolution: '1 km visible · 3 km infrared',
        bands: '12 channels, 0.6–14 µm; a full disk every 15 minutes',
        reveals: 'The volcanic-ash and dust composites over Europe and Africa.',
      }),
    ]),
    note: 'Parked at 0° alongside MTG-I1, in its last years of service.',
  }),
  Object.freeze({
    norad: 28912,
    name: 'Meteosat-9 (MSG-2)',
    operator: 'EUMETSAT',
    orbit: 'geostationary',
    platforms: Object.freeze(['Meteosat Second Generation']),
    instruments: Object.freeze([
      Object.freeze({
        name: 'SEVIRI',
        fullName: 'Spinning Enhanced Visible and Infrared Imager',
        swathKm: null,
        resolution: '1 km visible · 3 km infrared',
        bands: '12 channels, 0.6–14 µm; a full disk every 15 minutes',
        reveals:
          'The Indian Ocean Data Coverage service — the Arabian Sea to Australia.',
      }),
    ]),
    note: 'Parked at 45.5°E over the Indian Ocean.',
  }),
  // ---- The station: cameras, not a sensor, and a live stream rather than a product
  Object.freeze({
    norad: 25544,
    name: 'ISS',
    operator: 'NASA and partners',
    orbit: 'low Earth',
    platforms: Object.freeze([]),
    instruments: Object.freeze([
      Object.freeze({
        name: 'External cameras',
        fullName: 'Station exterior HD cameras',
        swathKm: null,
        resolution: 'HD video',
        bands: 'Visible',
        reveals:
          'The Earth from 400 km, live when NASA is streaming the exterior views — the ISS LIVE chip opens it.',
      }),
    ]),
    note: 'Not an imaging satellite; the stream alternates exterior views with mission coverage.',
  }),
]);

const BY_NORAD = new Map(IMAGING_PLATFORMS.map((p) => [p.norad, p]));

/**
 * The imaging platform behind a NORAD number, or null for a satellite whose
 * pictures this app cannot show.
 * @param {number|string} noradId
 * @returns {object|null}
 */
export function imagingPlatformFor(noradId) {
  return BY_NORAD.get(Number(noradId)) || null;
}

/**
 * The cross-track swath of a platform's widest imager, or null when it sees
 * a whole disk — what the footprint under a tracked satellite should draw.
 * @param {object|null} platform
 * @returns {number|null} Kilometres.
 */
export function swathKmFor(platform) {
  let widest = null;
  for (const instrument of platform?.instruments || []) {
    if (!Number.isFinite(instrument.swathKm)) continue;
    if (widest === null || instrument.swathKm > widest)
      widest = instrument.swathKm;
  }
  return widest;
}

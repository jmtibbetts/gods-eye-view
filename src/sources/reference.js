import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createOpenMhzSource } from '../layers/scanner/source.js';
import { createBundledSdrSource } from '../layers/sdr/source.js';
import { createBundledAtcSource } from '../layers/atc/source.js';
import { createNwsAlertsSource } from '../layers/weatherAlerts/source.js';
import { createSpcStormReportsSource } from '../layers/stormReports/source.js';
import { createUsgsVolcanoSource } from '../layers/volcanoes/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    cables: createBundledCableSource(),
    scanner: createOpenMhzSource(),
    sdr: createBundledSdrSource(),
    atc: createBundledAtcSource(),
    weatherAlerts: createNwsAlertsSource(),
    stormReports: createSpcStormReportsSource(),
    volcanoes: createUsgsVolcanoSource(),
  };
}

import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createOpenMhzSource } from '../layers/scanner/source.js';
import { createBundledSdrSource } from '../layers/sdr/source.js';
import { createBundledAtcSource } from '../layers/atc/source.js';
import { createNwsAlertsSource } from '../layers/weatherAlerts/source.js';
import { createSpcStormReportsSource } from '../layers/stormReports/source.js';
import { createUsgsVolcanoSource } from '../layers/volcanoes/source.js';
import { createNhcTropicalSource } from '../layers/tropical/source.js';
import { createAviationHazardSource } from '../layers/aviationHazards/source.js';
import { createTfrSource } from '../layers/tfr/source.js';
import { createConflictSource } from '../layers/conflictReports/source.js';
import { createDroughtSource } from '../layers/drought/source.js';
import { createLightningSource } from '../layers/lightning/source.js';
import { createNwpsGaugeSource } from '../layers/riverFlood/source.js';
import { createSatnogsSource } from '../layers/satnogs/source.js';
import { createSpcOutlookSource } from '../layers/severeOutlook/source.js';
import { createAirNowSource } from '../layers/airQuality/source.js';
import { createSwpcSource } from '../layers/spaceWeather/source.js';

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
    tropical: createNhcTropicalSource(),
    aviationHazards: createAviationHazardSource(),
    tfr: createTfrSource(),
    conflictReports: createConflictSource(),
    drought: createDroughtSource(),
    lightning: createLightningSource(),
    riverFlood: createNwpsGaugeSource(),
    satnogs: createSatnogsSource(),
    severeOutlook: createSpcOutlookSource(),
    airQuality: createAirNowSource(),
    spaceWeather: createSwpcSource(),
  };
}

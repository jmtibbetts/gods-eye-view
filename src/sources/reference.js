import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createOpenMhzSource } from '../layers/scanner/source.js';
import { createBundledSdrSource } from '../layers/sdr/source.js';
import { createBundledAtcSource } from '../layers/atc/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    cables: createBundledCableSource(),
    scanner: createOpenMhzSource(),
    sdr: createBundledSdrSource(),
    atc: createBundledAtcSource(),
  };
}

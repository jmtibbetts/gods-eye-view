import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the EPA AirNow air-quality layer to the shared context store. */
export function createApplicationAirQuality({ source }) {
  return createAirQualityLayer({ source, context });
}

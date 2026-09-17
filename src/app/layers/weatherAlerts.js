import { createWeatherAlertsLayer } from '../../layers/weatherAlerts/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the NWS weather-alerts layer to the shared context store (click cards). */
export function createApplicationWeatherAlerts({ source }) {
  return createWeatherAlertsLayer({ source, context });
}

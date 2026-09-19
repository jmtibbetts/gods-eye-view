import { createSpaceWeatherLayer } from '../../layers/spaceWeather/index.js';

/** Wire the SWPC space-weather layer; it draws ground-classified cells and needs no floors. */
export function createApplicationSpaceWeather({ source }) {
  return createSpaceWeatherLayer({ source });
}

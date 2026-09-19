import { createStormReportsLayer } from '../../layers/stormReports/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the NOAA SPC storm-reports layer to the shared context store (click cards) and ground floors. */
export function createApplicationStormReports({ surface, source }) {
  return createStormReportsLayer({
    source,
    context,
    ground: surface?.groundFloor ?? null,
  });
}

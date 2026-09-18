import { createAviationHazardsLayer } from '../../layers/aviationHazards/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the SIGMET hazard layer to the shared context store. */
export function createApplicationAviationHazards({ source }) {
  return createAviationHazardsLayer({ source, context });
}

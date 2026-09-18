import { createRiverFloodLayer } from '../../layers/riverFlood/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the NWPS river-gauge layer to the shared context store. */
export function createApplicationRiverFlood({ source }) {
  return createRiverFloodLayer({ source, context });
}

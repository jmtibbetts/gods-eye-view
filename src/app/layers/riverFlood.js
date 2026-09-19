import { createRiverFloodLayer } from '../../layers/riverFlood/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the NWPS river-gauge layer to the shared context store and ground floors. */
export function createApplicationRiverFlood({ surface, source }) {
  return createRiverFloodLayer({
    source,
    context,
    ground: surface?.groundFloor ?? null,
  });
}

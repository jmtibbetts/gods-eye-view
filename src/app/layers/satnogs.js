import { createSatnogsLayer } from '../../layers/satnogs/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the SatNOGS ground-station layer to the shared context store and ground floors. */
export function createApplicationSatnogs({ surface, source }) {
  return createSatnogsLayer({
    source,
    context,
    ground: surface?.groundFloor ?? null,
  });
}

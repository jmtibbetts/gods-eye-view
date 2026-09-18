import { createSatnogsLayer } from '../../layers/satnogs/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the SatNOGS ground-station layer to the shared context store. */
export function createApplicationSatnogs({ source }) {
  return createSatnogsLayer({ source, context });
}

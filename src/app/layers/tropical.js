import { createTropicalLayer } from '../../layers/tropical/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the NHC tropical-cyclone layer to the shared context store (click cards). */
export function createApplicationTropical({ source }) {
  return createTropicalLayer({ source, context });
}

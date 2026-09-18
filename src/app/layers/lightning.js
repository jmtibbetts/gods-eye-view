import { createLightningLayer } from '../../layers/lightning/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the GLM lightning layer to the shared context store. */
export function createApplicationLightning({ source }) {
  return createLightningLayer({ source, context });
}

import { createLightningLayer } from '../../layers/lightning/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the GLM lightning layer to the shared context store and ground floors. */
export function createApplicationLightning({ surface, source }) {
  return createLightningLayer({
    source,
    context,
    ground: surface?.groundFloor ?? null,
  });
}

import { createTropicalLayer } from '../../layers/tropical/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the NHC tropical-cyclone layer to the shared context store (click cards) and ground floors. */
export function createApplicationTropical({ surface, source }) {
  return createTropicalLayer({
    source,
    context,
    ground: surface?.groundFloor ?? null,
  });
}

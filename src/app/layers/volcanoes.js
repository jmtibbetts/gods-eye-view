import { createVolcanoesLayer } from '../../layers/volcanoes/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the USGS volcano-alert layer to the shared context store (click cards) and ground floors. */
export function createApplicationVolcanoes({ surface, source }) {
  return createVolcanoesLayer({
    source,
    context,
    ground: surface?.groundFloor ?? null,
  });
}

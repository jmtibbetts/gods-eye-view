import { createDroughtLayer } from '../../layers/drought/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the drought layer to the shared context store. */
export function createApplicationDrought({ source }) {
  return createDroughtLayer({ source, context });
}

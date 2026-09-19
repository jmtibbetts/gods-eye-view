import { createTfrLayer } from '../../layers/tfr/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the FAA flight-restriction layer to the shared context store. */
export function createApplicationTfr({ source }) {
  return createTfrLayer({ source, context });
}

import { createConjunctionsLayer } from '../../layers/conjunctions/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the SOCRATES conjunctions layer to the shared context store. */
export function createApplicationConjunctions({ source }) {
  return createConjunctionsLayer({ source, context });
}

import { createSevereOutlookLayer } from '../../layers/severeOutlook/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the SPC convective-outlook layer to the shared context store. */
export function createApplicationSevereOutlook({ source }) {
  return createSevereOutlookLayer({ source, context });
}

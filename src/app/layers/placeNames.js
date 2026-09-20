import { createPlaceNamesLayer } from '../../layers/placeNames/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire the place-names layer to the shared world-overlay host. */
export function createApplicationPlaceNames() {
  return createPlaceNamesLayer({ overlayHost });
}

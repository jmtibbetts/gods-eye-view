import { createScannerLayer } from '../../layers/scanner/index.js';
import * as context from '../../data/contextStore.js';
import { overlayHost } from './overlayHost.js';

/** Wire the OpenMHz scanner display to the application overlay host and context store. */
export function createApplicationScanner({ surface, ...options }) {
  return createScannerLayer({
    overlayHost,
    context,
    ground: surface?.groundFloor ?? null,
    ...options,
  });
}

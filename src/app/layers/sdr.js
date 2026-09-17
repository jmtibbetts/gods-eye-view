import { createSdrLayer } from '../../layers/sdr/index.js';
import * as context from '../../data/contextStore.js';
import { overlayHost } from './overlayHost.js';

/** Wire the web-SDR receiver display to the application overlay host and context store. */
export function createApplicationSdr({ surface, ...options }) {
  return createSdrLayer({
    overlayHost,
    context,
    ground: surface?.groundFloor ?? null,
    ...options,
  });
}

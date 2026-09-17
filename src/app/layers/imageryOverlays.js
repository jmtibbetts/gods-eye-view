import { createImageryOverlayLayers } from '../../layers/imageryOverlays/index.js';

/**
 * The imagery-overlay layers (VIIRS, GOES, weather radar). They own no scene
 * services beyond the viewer the manager hands them, so this adapter is a
 * thin pass-through kept for symmetry with the other app layer factories.
 */
export function createApplicationImageryOverlays() {
  return createImageryOverlayLayers();
}

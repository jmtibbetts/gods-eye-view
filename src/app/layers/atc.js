import { createAtcLayer } from '../../layers/atc/index.js';
import { sdrTunedUrl } from '../../layers/sdr/model.js';
import * as context from '../../data/contextStore.js';
import { overlayHost } from './overlayHost.js';

/**
 * Wire the ATC display to the application overlay host, the context store
 * (the follow engine reads the selected aircraft from it) and the SDR layer,
 * which supplies airband receivers within range of a facility.
 */
export function createApplicationAtc({ surface, sdr = null, ...options }) {
  const findSdr = sdr
    ? async ({ lat, lon, freqHz, maxKm }) => {
        await sdr.ensureSdrDirectory?.();
        const [best] =
          sdr.findSdrReceivers?.({
            lat,
            lon,
            freqHz,
            coveredOnly: true,
            limit: 1,
          }) ?? [];
        if (!best || !(best.distanceKm <= maxKm)) return null;
        return {
          receiver: best,
          url: sdrTunedUrl(best, { freqHz, mode: 'am' }),
        };
      }
    : null;
  return createAtcLayer({
    overlayHost,
    context,
    findSdr,
    ground: surface?.groundFloor ?? null,
    ...options,
  });
}

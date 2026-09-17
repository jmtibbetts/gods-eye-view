import { createAtcLayer } from '../../layers/atc/index.js';
import { sdrTunedUrl } from '../../layers/sdr/model.js';
import * as context from '../../data/contextStore.js';
import {
  republishTrackedReadout,
  setTrackedAircraftAnnotator,
} from '../../data/trackedReadout.js';
import { overlayHost } from './overlayHost.js';

/**
 * Wire the ATC display to the application overlay host, the context store
 * (the follow engine reads the selected aircraft from it) and the SDR layer,
 * which supplies airband receivers within range of a facility.
 *
 * Also wires the tracked-aircraft readout annotation: clicking any plane
 * (Live Flights or Military) adds a line naming the controller and frequency
 * it is on, whether or not the ATC dots layer is enabled. The annotator
 * self-loads the bundled directory on first use, and a selection listener
 * refreshes the card the moment a plane is picked.
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
  const layer = createAtcLayer({
    overlayHost,
    context,
    findSdr,
    ground: surface?.groundFloor ?? null,
    onAnnotationChange: republishTrackedReadout,
    ...options,
  });
  setTrackedAircraftAnnotator(() => layer.contactAnnotationText());
  // Repaint the readout as soon as a plane is selected, even with the ATC
  // dots layer off — the annotator lazy-loads the directory behind it.
  if (typeof window !== 'undefined') {
    window.addEventListener('gev:awareness-subject-selected', (event) => {
      if (
        event?.detail?.layerId === 'flights' ||
        event?.detail?.layerId === 'military'
      )
        republishTrackedReadout();
    });
  }
  return layer;
}

import { AIR_QUALITY_FETCH_TIMEOUT_MS, airNowQueryUrl } from './policy.js';
import { parseAirQuality } from './records.js';

/**
 * AirNow source. EPA's ArcGIS feature service is keyless and CORS-open, so
 * this reads it directly — verified in a browser rather than assumed, since
 * NOAA's own products differ between services.
 */
export function createAirNowSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = AIR_QUALITY_FETCH_TIMEOUT_MS,
} = {}) {
  return {
    async fetchAirQuality({ signal } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(airNowQueryUrl(), {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`AirNow HTTP ${response.status}`);
        return parseAirQuality(await response.json());
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

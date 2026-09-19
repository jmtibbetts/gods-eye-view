import {
  ALERTS_URL,
  AURORA_URL,
  KP_URL,
  SCALES_URL,
  SPACE_WEATHER_FETCH_TIMEOUT_MS,
} from './policy.js';
import { parseAlerts, parseAurora, parseKp, parseScales } from './records.js';

/**
 * SWPC source: four keyless JSON feeds read together. The oval is the one
 * that must arrive; the index, scales and alerts each degrade to "not
 * available" on their own rather than failing the layer.
 */
export function createSwpcSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = SPACE_WEATHER_FETCH_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  async function readJson(url, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new Error(
          `SWPC request timed out after ${Math.round(timeoutMs / 1000)}s`,
        ),
      );
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`SWPC HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (timedOut)
        throw new Error(
          `SWPC request timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  const optional = async (url, signal, parse) => {
    try {
      return parse(await readJson(url, signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  };

  return {
    async fetchSpaceWeather({ signal } = {}) {
      const [auroraPayload, kp, scales, alerts] = await Promise.all([
        readJson(AURORA_URL, signal),
        optional(KP_URL, signal, parseKp),
        optional(SCALES_URL, signal, parseScales),
        optional(ALERTS_URL, signal, (p) => parseAlerts(p, now())),
      ]);
      const aurora = parseAurora(auroraPayload);
      if (!aurora) throw new Error('Malformed OVATION aurora grid');
      return { aurora, kp, scales, alerts: alerts || [] };
    },
  };
}

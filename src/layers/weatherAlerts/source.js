import { NWS_ALERTS_URL, WEATHER_ALERTS_FETCH_TIMEOUT_MS } from './policy.js';
import { normalizeWeatherAlerts } from './records.js';

/**
 * Live NWS active-alerts source. Browser fetch sends its own User-Agent,
 * which api.weather.gov accepts; no key required.
 * @param {{fetchImpl?: typeof fetch, url?: string}} [options]
 */
export function createNwsAlertsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = NWS_ALERTS_URL,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        WEATHER_ALERTS_FETCH_TIMEOUT_MS,
      );
      const onAbort = () => timeout.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(url, {
          signal: timeout.signal,
          headers: { Accept: 'application/geo+json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`NWS alerts HTTP ${response.status}`);
        const payload = await response.json();
        signal?.throwIfAborted();
        const normalized = normalizeWeatherAlerts(payload);
        if (!normalized) throw new Error('Malformed NWS alerts payload');
        return normalized;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

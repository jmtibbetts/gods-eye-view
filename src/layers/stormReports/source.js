import {
  SPC_REPORTS_BASE,
  SPC_REPORT_DAYS,
  STORM_REPORTS_FETCH_TIMEOUT_MS,
} from './policy.js';
import { normalizeStormReports } from './records.js';

/**
 * Live NOAA SPC storm-reports source. Plain CSV over HTTPS with an open CORS
 * header, so the browser reads it directly — no key and no proxy.
 *
 * A day that fails to load is skipped rather than failing the whole snapshot:
 * yesterday's file being briefly unavailable should not blank out today's.
 *
 * @param {{fetchImpl?: typeof fetch, base?: string, days?: string[]}} [options]
 */
export function createSpcStormReportsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = SPC_REPORTS_BASE,
  days = SPC_REPORT_DAYS,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        STORM_REPORTS_FETCH_TIMEOUT_MS,
      );
      const onAbort = () => timeout.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const loaded = [];
        const failures = [];
        for (const day of days) {
          try {
            const response = await fetchImpl(`${base}/${day}.csv`, {
              signal: timeout.signal,
              cache: 'no-store',
            });
            if (!response.ok) {
              failures.push(`${day} HTTP ${response.status}`);
              continue;
            }
            loaded.push({ day, csv: await response.text() });
          } catch (error) {
            if (timeout.signal.aborted) throw error;
            failures.push(`${day} ${error?.message || 'unreachable'}`);
          }
        }
        signal?.throwIfAborted();
        if (!loaded.length)
          throw new Error(
            failures.length
              ? `SPC reports unavailable (${failures.join('; ')})`
              : 'SPC reports unavailable',
          );
        const { reports, byKind } = normalizeStormReports(loaded);
        return { reports, byKind, days: loaded.map((d) => d.day), failures };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

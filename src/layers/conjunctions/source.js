import { CONJUNCTIONS_FETCH_TIMEOUT_MS, CONJUNCTIONS_URL } from './policy.js';

/**
 * Conjunction source: the proxy's body as it is. The proxy reads SOCRATES
 * and fills in elements in the background; the layer decides what to do
 * with a body whose `pending` is not yet zero.
 */
export function createConjunctionSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = CONJUNCTIONS_FETCH_TIMEOUT_MS,
  url = CONJUNCTIONS_URL,
} = {}) {
  return {
    async fetchConjunctions({ signal } = {}) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new Error(
            `Conjunction request timed out after ${Math.round(timeoutMs / 1000)}s`,
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
        if (!response.ok)
          throw new Error(`Conjunctions HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.error)
          throw new Error(`Conjunctions unavailable: ${payload.error}`);
        if (!Array.isArray(payload?.conjunctions))
          throw new Error('Conjunction body is not a list');
        return payload;
      } catch (error) {
        if (timedOut)
          throw new Error(
            `Conjunction request timed out after ${Math.round(timeoutMs / 1000)}s`,
          );
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

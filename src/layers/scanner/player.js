import { SCANNER_DEFAULT_VOLUME, SCANNER_QUEUE_LIMIT } from './policy.js';

/**
 * A scanner-style call player: transmissions are queued in arrival order
 * and played back to back through one HTMLAudioElement, the way a desk
 * scanner steps through a busy system. Nothing is decoded client-side —
 * the element streams straight from OpenMHz's media host.
 *
 * `createAudio` is injectable so the queue logic is unit-testable without a
 * DOM; production passes `() => new Audio()`.
 *
 * @param {{createAudio?: () => HTMLAudioElement, queueLimit?: number, onChange?: (state: object) => void}} [options]
 */
export function createScannerPlayer({
  createAudio = () => new Audio(),
  queueLimit = SCANNER_QUEUE_LIMIT,
  onChange = () => {},
} = {}) {
  /** @type {HTMLAudioElement|null} */
  let audio = null;
  /** @type {Array<object>} */
  const queue = [];
  const seen = new Set();
  let current = null;
  let state = 'idle'; // idle | playing | waiting | paused | error
  let paused = false;
  let volume = SCANNER_DEFAULT_VOLUME;
  let dropped = 0;
  let lastError = null;

  function emit() {
    onChange(snapshot());
  }

  function snapshot() {
    return Object.freeze({
      state,
      paused,
      current,
      queued: queue.length,
      dropped,
      volume,
      error: lastError,
    });
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = createAudio();
    audio.preload = 'auto';
    audio.volume = volume;
    audio.addEventListener('ended', next);
    audio.addEventListener('playing', () => {
      if (state !== 'paused') {
        state = 'playing';
        emit();
      }
    });
    audio.addEventListener('waiting', () => {
      if (state === 'playing') {
        state = 'waiting';
        emit();
      }
    });
    audio.addEventListener('error', () => {
      lastError = 'clip unavailable';
      next();
    });
    return audio;
  }

  function next() {
    current = null;
    if (paused) {
      state = 'paused';
      emit();
      return;
    }
    const call = queue.shift();
    if (!call) {
      state = 'idle';
      emit();
      return;
    }
    play(call);
  }

  function play(call) {
    const element = ensureAudio();
    current = call;
    state = 'waiting';
    lastError = null;
    emit();
    try {
      element.src = call.url;
      const promise = element.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch((error) => {
          // Autoplay policy or a dead clip: skip rather than stall the queue.
          lastError =
            error?.name === 'NotAllowedError'
              ? 'tap to play'
              : 'clip unavailable';
          if (current === call) next();
        });
      }
    } catch {
      lastError = 'clip unavailable';
      next();
    }
  }

  return {
    /**
     * Queue calls in chronological order. Calls already seen are ignored so a
     * poll overlap never repeats a transmission.
     * @param {Array<object>} calls
     * @returns {number} Calls actually queued.
     */
    enqueue(calls) {
      let added = 0;
      for (const call of calls) {
        if (!call?.url || seen.has(call.id)) continue;
        seen.add(call.id);
        queue.push(call);
        added++;
      }
      while (queue.length > queueLimit) {
        queue.shift();
        dropped++;
      }
      if (seen.size > 2000) {
        // Bounded memory: forget the oldest half of the seen-set.
        const keep = [...seen].slice(-1000);
        seen.clear();
        for (const id of keep) seen.add(id);
      }
      if (added && !current && !paused) next();
      else emit();
      return added;
    },
    /** Mark ids as already heard (history on first select) without playing them. */
    markSeen(calls) {
      for (const call of calls) if (call?.id) seen.add(call.id);
    },
    pause() {
      paused = true;
      state = 'paused';
      try {
        audio?.pause();
      } catch {
        /* ignore */
      }
      emit();
    },
    resume() {
      paused = false;
      if (current && audio) {
        state = 'playing';
        emit();
        const promise = audio.play?.();
        if (promise && typeof promise.catch === 'function')
          promise.catch(() => next());
        return;
      }
      next();
    },
    toggle() {
      if (paused) this.resume();
      else this.pause();
    },
    setVolume(value) {
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      volume = Math.min(1, Math.max(0, v));
      if (audio) audio.volume = volume;
      emit();
    },
    /** Stop playback and forget the queue; the seen-set is kept per select. */
    stop() {
      queue.length = 0;
      current = null;
      paused = false;
      state = 'idle';
      try {
        if (audio) {
          audio.pause();
          audio.removeAttribute?.('src');
          audio.load?.();
        }
      } catch {
        /* ignore */
      }
      emit();
    },
    reset() {
      this.stop();
      seen.clear();
      dropped = 0;
      lastError = null;
    },
    destroy() {
      this.reset();
      audio = null;
    },
    getState: snapshot,
  };
}

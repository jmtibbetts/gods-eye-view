import {
  TIMELINE_SPAN_DAYS,
  clampOffset,
  displayDateForOffset,
  stepOffset,
  timelineLabel,
} from './timelineEngine.js';

/** How long each frame holds while playing back. */
const PLAY_INTERVAL_MS = 1400;

function setText(el, value) {
  if (el) el.textContent = value;
}

/**
 * TIMELINE panel: scrub the globe's daily satellite imagery back through the
 * archive, or play the last fortnight forward as an animation.
 *
 * Only feeds that actually carry an archive are moved. The panel asks each
 * enabled layer whether it is time-aware rather than assuming, and says which
 * ones it is driving — a scrubber that silently moved nothing, or that implied
 * it was moving live aircraft positions it cannot move, would be worse than no
 * scrubber at all.
 */
export class TimelinePanel {
  constructor({
    elements,
    dataManager,
    onToast,
    span = TIMELINE_SPAN_DAYS,
  } = {}) {
    this.elements = elements || {};
    this._resolveDataManager =
      typeof dataManager === 'function' ? dataManager : () => dataManager;
    this.onToast = typeof onToast === 'function' ? onToast : () => {};
    this.span = span;
    this.destroyed = false;
    this._abort = new AbortController();
    this._offset = 0;
    this._playTimer = null;
    this._applying = false;
  }

  connect() {
    const e = this.elements;
    const { signal } = this._abort;
    if (e.slider) {
      e.slider.min = '0';
      e.slider.max = String(Math.max(0, this.span - 1));
      e.slider.step = '1';
      // The slider reads left-to-right as past → present, so it carries the
      // inverted offset and is flipped on the way in and out.
      e.slider.value = String(this.span - 1 - this._offset);
      e.slider.addEventListener(
        'input',
        () => this.setOffset(this.span - 1 - Number(e.slider.value)),
        { signal },
      );
    }
    e.backBtn?.addEventListener('click', () => this.step(1), { signal });
    e.forwardBtn?.addEventListener('click', () => this.step(-1), { signal });
    e.liveBtn?.addEventListener('click', () => this.goLive(), { signal });
    e.playBtn?.addEventListener('click', () => this.togglePlay(), { signal });
    this.render();
  }

  /** Enabled layers that say they can be moved through time. */
  _timeAwareLayers() {
    const dm = this._resolveDataManager();
    const layers = [];
    if (!dm?.layers) return layers;
    for (const [id, entry] of dm.layers) {
      if (!dm.isEnabled?.(id)) continue;
      const module = entry?.module || entry;
      if (typeof module?.setDisplayDate !== 'function') continue;
      try {
        if (module.isTimeAware?.() !== true) continue;
      } catch {
        continue;
      }
      layers.push({ id, name: module.name || id, module });
    }
    return layers;
  }

  setOffset(offset) {
    const next = clampOffset(offset, this.span);
    if (next === this._offset) {
      this.render();
      return;
    }
    this._offset = next;
    this.render();
    void this._apply();
  }

  step(days) {
    this.setOffset(stepOffset(this._offset, days, this.span));
  }

  goLive() {
    this.stopPlay();
    this.setOffset(0);
  }

  async _apply() {
    if (this._applying || this.destroyed) return;
    this._applying = true;
    try {
      const date = displayDateForOffset(this._offset);
      const layers = this._timeAwareLayers();
      await Promise.all(
        layers.map((layer) =>
          Promise.resolve(layer.module.setDisplayDate(date)).catch(() => false),
        ),
      );
      this.render();
    } finally {
      this._applying = false;
    }
  }

  togglePlay() {
    if (this._playTimer) {
      this.stopPlay();
      return;
    }
    const layers = this._timeAwareLayers();
    if (!layers.length) {
      this.onToast(
        'TIMELINE: turn on Satellite Imagery or a Science Layer — nothing enabled carries an archive',
      );
      return;
    }
    // Start from the far end so play always runs past → present.
    if (this._offset === 0) this.setOffset(this.span - 1);
    this._playTimer = setInterval(() => {
      if (this._offset <= 0) {
        this.stopPlay();
        return;
      }
      this.step(-1);
    }, PLAY_INTERVAL_MS);
    this.render();
  }

  stopPlay() {
    if (this._playTimer) clearInterval(this._playTimer);
    this._playTimer = null;
    this.render();
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const live = this._offset === 0;
    setText(e.label, timelineLabel(this._offset));
    if (e.slider) e.slider.value = String(this.span - 1 - this._offset);
    if (e.layerState) setText(e.layerState, live ? 'LIVE' : 'ARCHIVE');
    if (e.playBtn) {
      e.playBtn.textContent = this._playTimer ? 'STOP' : 'PLAY';
      e.playBtn.setAttribute(
        'aria-label',
        this._playTimer ? 'Stop playback' : 'Play the archive forward',
      );
    }
    if (e.liveBtn) e.liveBtn.disabled = live;
    if (e.backBtn) e.backBtn.disabled = this._offset >= this.span - 1;
    if (e.forwardBtn) e.forwardBtn.disabled = live;
    if (e.note) {
      const layers = this._timeAwareLayers();
      setText(
        e.note,
        layers.length
          ? `Driving ${layers.map((l) => l.name).join(', ')}. Live feeds — aircraft, vessels, radar — always show now.`
          : 'Nothing enabled carries an archive. Turn on Satellite Imagery or a Science Layer to scrub back through it.',
      );
    }
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this.stopPlay();
  }
}

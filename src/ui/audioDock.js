/**
 * In-map receiver dock: a draggable, resizable frame that hosts a web SDR
 * (waterfall and all) or a LiveATC airport page without leaving the globe.
 *
 * The dock is a plain iframe host. It does not touch the framed page: the
 * receiver's own controls, user limits and audio stay the operator's. Some
 * sites refuse to be framed; the dock cannot see that from outside, so it
 * always offers POP OUT, which opens the same URL in its own tab.
 */

const SIZES = Object.freeze({
  normal: Object.freeze({ width: 680, height: 440 }),
  large: Object.freeze({ width: 980, height: 620 }),
});
const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;
const EDGE_MARGIN = 8;
const STORAGE_KEY = 'gev.audioDock.v1';
/** Named tab reused for pages that refuse to be framed (LiveATC). */
export const EXTERNAL_TAB_NAME = 'gev-receiver';

/** Assign text without naming string literals in the assignment itself. */
function setText(el, value) {
  if (el) el.textContent = value;
}

/** Only http(s) pages are framed; anything else is refused. */
export function audioDockUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

export class AudioDock {
  /**
   * @param {object} options
   * @param {object} options.elements root, bar, kind, title, subtitle, note, frame, reloadBtn, sizeBtn, popoutBtn, closeBtn
   * @param {Storage|null} [options.storage] Per-viewer position memory (optional).
   * @param {(url: string, target?: string) => void} [options.openTab] Pop-out hand-off.
   */
  constructor({ elements, storage = null, openTab } = {}) {
    this.elements = elements || {};
    this.storage = storage;
    this.openTab =
      openTab ||
      ((url, target = '_blank') => {
        if (typeof window === 'undefined') return;
        const tab = window.open(url, target, 'noopener,noreferrer');
        if (tab) tab.opener = null;
      });
    this.destroyed = false;
    this._abort = new AbortController();
    this._state = {
      open: false,
      url: null,
      kind: null,
      layerId: null,
      title: '',
      subtitle: '',
      note: '',
      external: false,
      size: 'normal',
      openedAt: null,
    };
    /** @type {Set<(state: object) => void>} */
    this._listeners = new Set();
    this._drag = null;
    this._position = null;
    this._restorePosition();
    this._bind();
  }

  _bind() {
    const e = this.elements;
    const { signal } = this._abort;
    e.closeBtn?.addEventListener('click', () => this.close(), { signal });
    const popOut = () => {
      if (!this._state.url) return;
      this.openTab(
        this._state.url,
        this._state.external ? EXTERNAL_TAB_NAME : '_blank',
      );
    };
    e.popoutBtn?.addEventListener('click', popOut, { signal });
    e.externalBtn?.addEventListener('click', popOut, { signal });
    e.reloadBtn?.addEventListener('click', () => this.reload(), { signal });
    e.sizeBtn?.addEventListener('click', () => this.toggleSize(), { signal });
    e.bar?.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 || event.target?.closest('button')) return;
        const rect = e.root.getBoundingClientRect();
        this._drag = {
          pointerId: event.pointerId,
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
        };
        e.bar.setPointerCapture?.(event.pointerId);
        e.root.classList.add('dragging');
        event.preventDefault();
      },
      { signal },
    );
    e.bar?.addEventListener(
      'pointermove',
      (event) => {
        if (!this._drag || event.pointerId !== this._drag.pointerId) return;
        this._place(
          event.clientX - this._drag.dx,
          event.clientY - this._drag.dy,
        );
      },
      { signal },
    );
    const endDrag = (event) => {
      if (!this._drag || event.pointerId !== this._drag.pointerId) return;
      this._drag = null;
      e.root.classList.remove('dragging');
      this._persist();
    };
    e.bar?.addEventListener('pointerup', endDrag, { signal });
    e.bar?.addEventListener('pointercancel', endDrag, { signal });
    if (typeof window !== 'undefined')
      window.addEventListener('resize', () => this._clamp(), { signal });
    // A resize handle (CSS resize: both) changes the box; remember it.
    if (typeof ResizeObserver !== 'undefined' && e.root) {
      this._resizeObserver = new ResizeObserver(() => {
        if (this._state.open && !this._drag) this._persist();
      });
      this._resizeObserver.observe(e.root);
    }
    this._render();
  }

  _restorePosition() {
    try {
      const raw = this.storage?.getItem?.(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (
        Number.isFinite(saved?.left) &&
        Number.isFinite(saved?.top) &&
        Number.isFinite(saved?.width) &&
        Number.isFinite(saved?.height)
      )
        this._position = saved;
      if (saved?.size === 'large') this._state.size = 'large';
    } catch {
      /* storage is a nicety */
    }
  }

  _persist() {
    const root = this.elements.root;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    this._position = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      size: this._state.size,
    };
    try {
      this.storage?.setItem?.(STORAGE_KEY, JSON.stringify(this._position));
    } catch {
      /* storage is a nicety */
    }
  }

  _viewport() {
    if (typeof window === 'undefined') return { width: 1280, height: 800 };
    return { width: window.innerWidth, height: window.innerHeight };
  }

  _place(left, top) {
    const root = this.elements.root;
    if (!root) return;
    const view = this._viewport();
    const rect = root.getBoundingClientRect();
    const maxLeft = Math.max(
      EDGE_MARGIN,
      view.width - rect.width - EDGE_MARGIN,
    );
    const maxTop = Math.max(
      EDGE_MARGIN,
      view.height - rect.height - EDGE_MARGIN,
    );
    root.style.left = `${Math.round(Math.min(maxLeft, Math.max(EDGE_MARGIN, left)))}px`;
    root.style.top = `${Math.round(Math.min(maxTop, Math.max(EDGE_MARGIN, top)))}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  _applyBox() {
    const root = this.elements.root;
    if (!root) return;
    const view = this._viewport();
    const size = SIZES[this._state.size] || SIZES.normal;
    const saved = this._position;
    const width = Math.max(
      MIN_WIDTH,
      Math.min(view.width - EDGE_MARGIN * 2, saved?.width || size.width),
    );
    const height = Math.max(
      MIN_HEIGHT,
      Math.min(view.height - EDGE_MARGIN * 2, saved?.height || size.height),
    );
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    if (saved) this._place(saved.left, saved.top);
    else this._place(EDGE_MARGIN + 12, view.height - height - 96);
  }

  _clamp() {
    const root = this.elements.root;
    if (!root || !this._state.open) return;
    const rect = root.getBoundingClientRect();
    this._place(rect.left, rect.top);
  }

  /**
   * Show a page in the dock — framed, or, for `external` pages that refuse
   * framing, in one named tab that later opens retarget, with the dock
   * describing what that tab is pointed at.
   * @param {string} url
   * @param {{kind?:string, layerId?:string, title?:string, subtitle?:string, note?:string, external?:boolean}} [meta]
   * @returns {boolean} False when the URL was refused.
   */
  open(url, meta = {}) {
    if (this.destroyed) return false;
    const safe = audioDockUrl(url);
    if (!safe) return false;
    const e = this.elements;
    const changed = safe !== this._state.url;
    const external = Boolean(meta.external);
    this._state = {
      ...this._state,
      open: true,
      url: safe,
      kind: meta.kind || 'page',
      layerId: meta.layerId || null,
      title: meta.title || '',
      subtitle: meta.subtitle || '',
      note: external ? '' : meta.note || '',
      external,
      openedAt: Date.now(),
    };
    if (e.root) {
      e.root.hidden = false;
      e.root.dataset.kind = this._state.kind;
      e.root.dataset.external = external ? 'true' : 'false';
      this._applyBox();
    }
    if (external) {
      if (e.frame && e.frame.getAttribute('src') !== 'about:blank')
        e.frame.setAttribute('src', 'about:blank');
      if (changed) this.openTab(safe, EXTERNAL_TAB_NAME);
    } else if (e.frame && (changed || e.frame.getAttribute('src') !== safe)) {
      e.frame.setAttribute('src', safe);
    }
    this._render();
    this._emit();
    return true;
  }

  reload() {
    const e = this.elements;
    if (!this._state.open) return;
    if (this._state.external) {
      this.openTab(this._state.url, EXTERNAL_TAB_NAME);
      return;
    }
    if (!e.frame) return;
    // Setting src again reloads a cross-origin frame without reading it.
    e.frame.setAttribute('src', this._state.url);
  }

  close() {
    if (!this._state.open) return;
    const e = this.elements;
    if (e.frame) e.frame.setAttribute('src', 'about:blank');
    if (e.root) e.root.hidden = true;
    this._state = {
      ...this._state,
      open: false,
      url: null,
      kind: null,
      layerId: null,
      title: '',
      subtitle: '',
      note: '',
      external: false,
    };
    this._render();
    this._emit();
  }

  toggleSize() {
    this._state.size = this._state.size === 'large' ? 'normal' : 'large';
    this._position = null;
    this._applyBox();
    this._persist();
    this._render();
  }

  isOpen() {
    return this._state.open;
  }

  getState() {
    return Object.freeze({ ...this._state });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    try {
      listener(this.getState());
    } catch {
      /* listener's problem */
    }
    return () => this._listeners.delete(listener);
  }

  _emit() {
    const state = this.getState();
    for (const listener of this._listeners) {
      try {
        listener(state);
      } catch (error) {
        console.warn('[AudioDock] listener failed:', error);
      }
    }
  }

  _render() {
    const e = this.elements;
    const s = this._state;
    setText(
      e.kind,
      s.kind === 'sdr' ? 'SDR' : s.kind === 'liveatc' ? 'LIVEATC' : 'PAGE',
    );
    setText(e.title, s.title || (s.url ? new URL(s.url).host : ''));
    setText(e.subtitle, s.subtitle);
    if (e.note) {
      setText(e.note, s.note);
      e.note.hidden = !s.note;
    }
    if (e.external) {
      e.external.hidden = !(s.open && s.external);
      setText(e.externalTitle, s.title);
      setText(
        e.externalText,
        s.external
          ? `${s.subtitle ? s.subtitle + ' · ' : ''}LiveATC does not allow its pages inside other sites, so this one is open in its own tab (look for the "${EXTERNAL_TAB_NAME}" tab). Press LISTEN there for the frequency shown. As the target changes, that same tab is pointed at the new airport.`
          : '',
      );
    }
    if (e.frame) e.frame.hidden = Boolean(s.external);
    if (e.sizeBtn)
      e.sizeBtn.setAttribute(
        'aria-pressed',
        s.size === 'large' ? 'true' : 'false',
      );
    if (e.frame && s.title) e.frame.title = s.title;
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._listeners.clear();
    const e = this.elements;
    if (e.frame) e.frame.setAttribute('src', 'about:blank');
    if (e.root) e.root.hidden = true;
  }
}

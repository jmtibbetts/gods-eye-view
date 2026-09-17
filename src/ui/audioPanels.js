import * as Cesium from 'cesium';
import { cameraPoseSignature } from '../data/iconOrientation.js';

/**
 * Context-rail panels for the two audio layers:
 *
 *  - SCANNERS — the public-safety radio systems nearest the current view,
 *    a live call ticker for the selected one, and transport controls.
 *  - SDR / HAM — the web SDR receivers nearest the current view, a tune
 *    field, and an OPEN RECEIVER hand-off.
 *
 * Both follow the RadioControls contract: `connect()` after the layer
 * manager is live, `destroy()` on teardown, `actions` for the manager-level
 * verbs the shell owns (enable/disable through the lifecycle, camera
 * flights, panel disclosure).
 */

const LIST_REFRESH_MS = 1500;

/** Assign text without naming string literals in the assignment itself. */
function setText(el, value) {
  if (el) el.textContent = value;
}

function viewportAnchor(viewer) {
  const camera = viewer?.camera;
  const scene = viewer?.scene;
  if (!camera) return null;
  let cartographic = null;
  const canvas = scene?.canvas;
  if (canvas && typeof camera.pickEllipsoid === 'function') {
    const center = new Cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const position = camera.pickEllipsoid(
      center,
      scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
    );
    if (position) cartographic = Cesium.Cartographic.fromCartesian(position);
  }
  cartographic ||= camera.positionCartographic || null;
  if (!cartographic) return null;
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
  };
}

function kmText(km) {
  if (!Number.isFinite(km)) return '';
  return km < 10 ? `${km.toFixed(0)} km` : `${Math.round(km)} km`;
}

function flyTo(viewer, lat, lon, heightM = 40_000) {
  if (!viewer?.camera || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-55),
      roll: 0,
    },
    duration: 1.6,
  });
}

/** Shared enable/disable button behaviour, routed through the lifecycle. */
async function toggleLayer(control, enabling) {
  const btn = control.elements.enableBtn;
  if (!btn || control.destroyed) return;
  btn.setAttribute('aria-disabled', 'true');
  btn.setAttribute('aria-busy', 'true');
  try {
    await control.actions.runUserAction(
      (notificationToken) =>
        control.actions.setEnabled(enabling, {
          origin: 'user',
          notificationToken,
        }),
      `${control.label} could not ${enabling ? 'start' : 'stop'} cleanly`,
    );
  } finally {
    if (!control.destroyed) {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('aria-busy');
      control.render();
    }
  }
}

function lifecycleState(control) {
  const state = control.actions.getLifecycle?.();
  if (state === 'enabling' || state === 'disabling') return state;
  return control.actions.isEnabled?.() ? 'enabled' : 'disabled';
}

function paintEnableButton(control, state) {
  const btn = control.elements.enableBtn;
  if (!btn) return;
  const enabled = state === 'enabled';
  setText(
    btn,
    state === 'enabling'
      ? 'STARTING…'
      : state === 'disabling'
        ? 'STOPPING…'
        : enabled
          ? 'DISABLE'
          : 'ENABLE',
  );
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btn.classList.toggle('active', enabled);
}

function renderList({ list, rows, selectedId, render, onPick }) {
  if (!list) return;
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', row.id === selectedId ? 'true' : 'false');
    li.dataset.id = row.id;
    if (row.id === selectedId) li.classList.add('selected');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'audio-list-row';
    render(button, row);
    button.addEventListener('click', () => onPick(row));
    li.append(button);
    list.append(li);
  }
}

/** SCANNERS panel. */
export class ScannerPanel {
  constructor({ elements, layer, actions, viewer }) {
    this.elements = elements;
    this.layer = layer;
    this.actions = actions;
    this.viewer = viewer;
    this.label = 'Scanners';
    this.destroyed = false;
    this._abort = new AbortController();
    this._unsubscribe = null;
    this._timer = null;
    this._pose = null;
    this._state = null;
    this._rows = [];
  }

  connect() {
    const { signal } = this._abort;
    const e = this.elements;
    e.enableBtn?.addEventListener(
      'click',
      () => toggleLayer(this, !this.actions.isEnabled?.()),
      { signal },
    );
    e.search?.addEventListener(
      'input',
      () => this.refreshList({ force: true }),
      {
        signal,
      },
    );
    e.pauseBtn?.addEventListener(
      'click',
      () => this.layer.toggleScannerPlayback?.(),
      { signal },
    );
    e.stopBtn?.addEventListener('click', () => this.layer.stopScanner?.(), {
      signal,
    });
    e.flyBtn?.addEventListener(
      'click',
      () => {
        const s = this.layer.getSelectedScannerSystem?.();
        if (s) flyTo(this.viewer, s.lat, s.lon, 60_000);
      },
      { signal },
    );
    e.volume?.addEventListener(
      'input',
      () => {
        const v = Number(e.volume.value) / 100;
        this.layer.setScannerVolume?.(v);
        if (e.volumeValue) setText(e.volumeValue, `${Math.round(v * 100)}%`);
      },
      { signal },
    );
    this._unsubscribe = this.layer.subscribeScanner?.((state) => {
      this._state = state;
      this.render();
    });
    this._timer = setInterval(() => this.refreshList(), LIST_REFRESH_MS);
    this.refreshList({ force: true });
    this.render();
  }

  refreshList({ force = false } = {}) {
    if (this.destroyed) return;
    const enabled = this.actions.isEnabled?.();
    if (!enabled) {
      if (this._rows.length) {
        this._rows = [];
        this.renderList();
      }
      return;
    }
    const camera = this.viewer?.camera;
    const pose = camera ? cameraPoseSignature(camera) : null;
    if (!force && pose === this._pose) return;
    this._pose = pose;
    const anchor = viewportAnchor(this.viewer);
    if (!anchor) return;
    this._rows =
      this.layer.nearestScannerSystems?.({
        ...anchor,
        query: this.elements.search?.value ?? '',
        limit: 14,
      }) ?? [];
    this.renderList();
  }

  renderList() {
    const e = this.elements;
    const selectedId = this._state?.selected ?? null;
    renderList({
      list: e.list,
      rows: this._rows,
      selectedId,
      render: (button, row) => {
        const rate = Number(row.callAvg) || 0;
        const band =
          rate >= 10 ? 'hot' : rate >= 3 ? 'busy' : rate > 0 ? 'quiet' : 'idle';
        button.innerHTML = `<span class="audio-list-dot ${band}" aria-hidden="true"></span><span class="audio-list-main"><strong></strong><span></span></span><span class="audio-list-side"><b></b><i></i></span>`;
        setText(button.querySelector('strong'), row.name);
        setText(button.querySelector('.audio-list-main span'), row.place);
        setText(
          button.querySelector('b'),
          rate ? `${rate.toFixed(rate >= 10 ? 0 : 1)}/min` : 'quiet',
        );
        setText(button.querySelector('i'), kmText(row.distanceKm));
        button.title =
          row.id === selectedId
            ? 'Click to pause / resume'
            : `Listen to ${row.name}`;
      },
      onPick: (row) => {
        if (row.id === selectedId) this.layer.toggleScannerPlayback?.();
        else this.layer.selectScannerSystem?.(row.id);
      },
    });
    if (e.listCount)
      setText(
        e.listCount,
        this._rows.length
          ? `${this._rows.length} shown · ${this._state?.active ?? 0} live of ${this._state?.systems ?? 0}`
          : '',
      );
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const s = this._state;
    const lifecycle = lifecycleState(this);
    const enabled = lifecycle === 'enabled';
    paintEnableButton(this, lifecycle);
    if (e.layerState) {
      setText(
        e.layerState,
        enabled
          ? s?.selected
            ? s.player?.paused
              ? 'PAUSED'
              : 'LIVE'
            : `${s?.active ?? 0} LIVE`
          : lifecycle === 'enabling'
            ? 'SYNC'
            : 'OFF',
      );
      e.layerState.classList.toggle('active', enabled);
    }
    if (e.search) e.search.disabled = !enabled;
    const hasSelection = enabled && Boolean(s?.selected);
    if (e.pauseBtn) {
      e.pauseBtn.disabled = !hasSelection;
      setText(e.pauseBtn, s?.player?.paused ? 'RESUME' : 'PAUSE');
      e.pauseBtn.classList.toggle('active', hasSelection && !s?.player?.paused);
    }
    if (e.stopBtn) e.stopBtn.disabled = !hasSelection;
    if (e.flyBtn) e.flyBtn.disabled = !hasSelection;
    if (e.nowName)
      setText(
        e.nowName,
        hasSelection
          ? s.selectedName
          : enabled
            ? 'NO SYSTEM SELECTED'
            : 'SCANNERS OFF',
      );
    if (e.nowMeta) {
      if (hasSelection) {
        const status =
          s.session?.status === 'error'
            ? 'feed unavailable'
            : s.player?.paused
              ? 'paused'
              : s.player?.state === 'playing' || s.player?.state === 'waiting'
                ? 'live'
                : 'monitoring';
        setText(
          e.nowMeta,
          `${s.selectedPlace} · ${status} · ${(s.selectedRate ?? 0).toFixed(1)} calls/min · ${s.player?.queued ?? 0} queued`,
        );
      } else {
        setText(
          e.nowMeta,
          enabled
            ? 'Pick a system from the list or a globe marker.'
            : 'Enable Scanners, then pick a system from the list or a globe marker.',
        );
      }
    }
    if (e.nowCalls) {
      e.nowCalls.replaceChildren();
      for (const line of hasSelection ? s.recentLines : []) {
        const li = document.createElement('li');
        setText(li, line);
        if (line.startsWith('▶')) li.classList.add('playing');
        e.nowCalls.append(li);
      }
    }
    if (e.playbackState) {
      const error = s?.error || s?.player?.error;
      setText(
        e.playbackState,
        !enabled
          ? 'Scanners off'
          : error
            ? error
            : hasSelection
              ? s.player?.state === 'playing'
                ? 'Playing transmissions as they arrive'
                : s.player?.paused
                  ? 'Paused — click RESUME to continue'
                  : 'Waiting for traffic…'
              : `${s?.active ?? 0} systems with live traffic`,
      );
      e.playbackState.classList.toggle('error', Boolean(error));
    }
    if (e.volume && s?.player && Number.isFinite(s.player.volume)) {
      const pct = Math.round(s.player.volume * 100);
      if (
        Number(e.volume.value) !== pct &&
        document.activeElement !== e.volume
      ) {
        e.volume.value = String(pct);
        if (e.volumeValue) setText(e.volumeValue, `${pct}%`);
      }
    }
    this.renderList();
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

/** SDR / HAM panel. */
export class SdrPanel {
  constructor({ elements, layer, actions, viewer }) {
    this.elements = elements;
    this.layer = layer;
    this.actions = actions;
    this.viewer = viewer;
    this.label = 'SDR';
    this.destroyed = false;
    this._abort = new AbortController();
    this._unsubscribe = null;
    this._timer = null;
    this._pose = null;
    this._state = null;
    this._rows = [];
  }

  connect() {
    const { signal } = this._abort;
    const e = this.elements;
    e.enableBtn?.addEventListener(
      'click',
      () => toggleLayer(this, !this.actions.isEnabled?.()),
      { signal },
    );
    e.search?.addEventListener(
      'input',
      () => this.refreshList({ force: true }),
      {
        signal,
      },
    );
    const applyTune = () => {
      const mhz = Number(e.freq?.value);
      const mode = e.mode?.value || 'am';
      this.layer.setSdrTune?.(
        Number.isFinite(mhz) && mhz > 0
          ? { freqHz: Math.round(mhz * 1e6), mode }
          : null,
      );
      this.refreshList({ force: true });
    };
    e.freq?.addEventListener('change', applyTune, { signal });
    e.freq?.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') {
          applyTune();
          event.preventDefault();
        }
      },
      { signal },
    );
    e.mode?.addEventListener('change', applyTune, { signal });
    e.openBtn?.addEventListener(
      'click',
      () => this.layer.openSelectedSdrReceiver?.(),
      { signal },
    );
    e.clearBtn?.addEventListener(
      'click',
      () => this.layer.clearSdrSelection?.(),
      {
        signal,
      },
    );
    e.flyBtn?.addEventListener(
      'click',
      () => {
        const r = this.layer.getSelectedSdrReceiver?.();
        if (r) flyTo(this.viewer, r.lat, r.lon, 25_000);
      },
      { signal },
    );
    this._unsubscribe = this.layer.subscribeSdr?.((state) => {
      this._state = state;
      this.render();
    });
    this._timer = setInterval(() => this.refreshList(), LIST_REFRESH_MS);
    this.refreshList({ force: true });
    this.render();
  }

  refreshList({ force = false } = {}) {
    if (this.destroyed) return;
    const enabled = this.actions.isEnabled?.();
    if (!enabled) {
      if (this._rows.length) {
        this._rows = [];
        this.renderList();
      }
      return;
    }
    const camera = this.viewer?.camera;
    const pose = camera ? cameraPoseSignature(camera) : null;
    if (!force && pose === this._pose) return;
    this._pose = pose;
    const anchor = viewportAnchor(this.viewer);
    if (!anchor) return;
    const q = String(this.elements.search?.value ?? '')
      .toLowerCase()
      .trim();
    const tune = this._state?.tune;
    const candidates =
      this.layer.findSdrReceivers?.({
        ...anchor,
        freqHz: tune?.freqHz,
        limit: q ? 200 : 14,
      }) ?? [];
    this._rows = q
      ? candidates
          .filter((r) =>
            `${r.name} ${r.type} ${r.url}`.toLowerCase().includes(q),
          )
          .slice(0, 14)
      : candidates;
    this.renderList();
  }

  renderList() {
    const e = this.elements;
    const selectedId = this._state?.selected ?? null;
    const typeLabel = {
      kiwisdr: 'KiwiSDR',
      websdr: 'WebSDR',
      openwebrx: 'OpenWebRX',
      ubersdr: 'UberSDR',
      novasdr: 'NovaSDR',
      web888: 'Web-888',
      sdr: 'SDR',
    };
    renderList({
      list: e.list,
      rows: this._rows,
      selectedId,
      render: (button, row) => {
        button.innerHTML = `<span class="audio-list-dot ${row.type}" aria-hidden="true"></span><span class="audio-list-main"><strong></strong><span></span></span><span class="audio-list-side"><b></b><i></i></span>`;
        setText(button.querySelector('strong'), row.name);
        const band = Array.isArray(row.bands)
          ? `${(row.bands[0] / 1e6).toFixed(row.bands[0] ? 1 : 0)}–${(row.bands[1] / 1e6).toFixed(row.bands[1] >= 100e6 ? 0 : 1)} MHz`
          : 'band unlisted';
        setText(button.querySelector('.audio-list-main span'), band);
        setText(button.querySelector('b'), typeLabel[row.type] || 'SDR');
        setText(button.querySelector('i'), kmText(row.distanceKm));
        button.title =
          row.id === selectedId
            ? 'Click to open this receiver'
            : `Select ${row.name}`;
      },
      onPick: (row) => {
        if (row.id === selectedId) this.layer.openSelectedSdrReceiver?.();
        else this.layer.selectSdrReceiver?.(row.id);
      },
    });
    if (e.listCount)
      setText(
        e.listCount,
        this._rows.length
          ? `${this._rows.length} shown of ${this._state?.receivers ?? 0}${this._state?.tune ? ' covering ' + (this._state.tune.freqHz / 1e6).toFixed(3) + ' MHz' : ''}`
          : '',
      );
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const s = this._state;
    const lifecycle = lifecycleState(this);
    const enabled = lifecycle === 'enabled';
    paintEnableButton(this, lifecycle);
    if (e.layerState) {
      setText(
        e.layerState,
        enabled
          ? s?.selected
            ? 'SELECTED'
            : `${s?.receivers ?? 0} RX`
          : lifecycle === 'enabling'
            ? 'SYNC'
            : 'OFF',
      );
      e.layerState.classList.toggle('active', enabled);
    }
    for (const el of [e.search, e.freq, e.mode]) if (el) el.disabled = !enabled;
    const r = enabled ? s?.selectedReceiver : null;
    if (e.openBtn) e.openBtn.disabled = !r;
    if (e.flyBtn) e.flyBtn.disabled = !r;
    if (e.clearBtn) e.clearBtn.disabled = !r;
    if (e.nowName)
      setText(
        e.nowName,
        r ? r.name : enabled ? 'NO RECEIVER SELECTED' : 'SDR OFF',
      );
    if (e.nowMeta) {
      if (r) {
        const parts = [];
        if (Array.isArray(r.bands))
          parts.push(
            `${(r.bands[0] / 1e6).toFixed(1)}–${(r.bands[1] / 1e6).toFixed(1)} MHz`,
          );
        if (r.antenna) parts.push(r.antenna);
        if (r.usersMax) parts.push(`${r.usersMax} slots`);
        if (s.tune)
          parts.push(
            `tune ${(s.tune.freqHz / 1e6).toFixed(3)} MHz ${String(s.tune.mode).toUpperCase()}`,
          );
        try {
          parts.push(new URL(r.url).host);
        } catch {
          /* ignore */
        }
        setText(e.nowMeta, parts.join(' · '));
      } else {
        setText(
          e.nowMeta,
          enabled
            ? 'Pick a receiver from the list or a globe marker. Set a frequency to filter by coverage.'
            : 'Enable SDR, then pick a receiver from the list or a globe marker.',
        );
      }
    }
    if (e.playbackState) {
      setText(
        e.playbackState,
        !enabled
          ? 'SDR off'
          : s?.error
            ? s.error
            : r
              ? 'OPEN RECEIVER launches it in a new tab, tuned if a frequency is set'
              : `${s?.receivers ?? 0} public receivers in the directory`,
      );
      e.playbackState.classList.toggle('error', Boolean(s?.error));
    }
    this.renderList();
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

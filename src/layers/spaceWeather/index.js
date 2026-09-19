import * as Cesium from 'cesium';
import {
  G_SCALE_TEXT,
  SPACE_WEATHER_LAYER_ID,
  SPACE_WEATHER_UPDATE_MS,
  kpText,
} from './policy.js';
import { bandCells } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createSwpcSource } from './source.js';

/**
 * Space weather — the aurora oval on the globe, with Kp, the R/S/G scales
 * and SWPC's alerts on the layer row.
 *
 * The oval is drawn as ground-classified cells, one per whole degree the
 * forecast says is worth drawing, so it sits on terrain and on the
 * photoreal tiles alike; an imagery layer would vanish under Google 3D.
 * Cells are batched one primitive per colour band, a few thousand
 * rectangles at most, which Cesium builds off the main thread.
 *
 * What the legend says is what SWPC says: the oval is a forecast for a
 * time about half an hour ahead, named as such; Kp is three-hourly and
 * lags; a G-storm level is their now-cast. The radio user gets the one
 * line they need — the R scale — because an R2 blackout is why the HF
 * bands went quiet.
 *
 * @param {object} options
 * @param {{fetchSpaceWeather: Function}} options.source
 * @param {(instances: object[], band: object) => object} [options.primitiveFactory]
 *   Injectable for tests; defaults to a GroundPrimitive per band.
 */
export function createSpaceWeatherLayer({
  source,
  primitiveFactory = null,
} = {}) {
  if (typeof source?.fetchSpaceWeather !== 'function')
    throw new TypeError('Space weather layer requires an SWPC source');

  let _viewer = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  /** @type {object[]} */
  let _primitives = [];
  let _report = null;

  const buildPrimitive =
    primitiveFactory ||
    ((instances) =>
      new Cesium.GroundPrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
        }),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
        show: true,
      }));

  function notifyRowControls() {
    try {
      _rowControlsListener?.();
    } catch {
      /* a listener failure must not break a refresh */
    }
  }

  function clearPrimitives() {
    const primitives = _viewer?.scene?.primitives;
    for (const p of _primitives) {
      try {
        primitives?.remove(p);
      } catch {
        /* scene may be tearing down */
      }
    }
    _primitives = [];
  }

  function draw(aurora) {
    clearPrimitives();
    const primitives = _viewer?.scene?.primitives;
    if (!primitives) return;
    for (const { band, cells } of bandCells(aurora.cells)) {
      const color = Cesium.Color.fromCssColorString(band.color).withAlpha(
        band.alpha,
      );
      const instances = cells.map(
        (cell) =>
          new Cesium.GeometryInstance({
            geometry: new Cesium.RectangleGeometry({
              // Clamped to the ellipsoid's edges: the cell centred on 180°
              // would otherwise ask for an east edge past the antimeridian.
              rectangle: Cesium.Rectangle.fromDegrees(
                Math.max(-180, cell.lon - 0.5),
                Math.max(-89.9, cell.lat - 0.5),
                Math.min(180, cell.lon + 0.5),
                Math.min(89.9, cell.lat + 0.5),
              ),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
            },
            id: `${SPACE_WEATHER_LAYER_ID}:${band.min}`,
          }),
      );
      if (!instances.length) continue;
      const primitive = buildPrimitive(instances, band);
      primitives.add(primitive);
      _primitives.push(primitive);
    }
  }

  async function refresh() {
    if (!_enabled) return false;
    _abort?.abort();
    _abort = new AbortController();
    try {
      const report = await source.fetchSpaceWeather({ signal: _abort.signal });
      if (!_enabled) return false;
      _report = report;
      draw(report.aurora);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn('[Data:SpaceWeather] load error:', error);
      _lastError = error?.message || 'Space weather unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: SPACE_WEATHER_LAYER_ID,
    name: 'Space Weather',
    icon: '🌌',
    source: 'NOAA SWPC',
    updateInterval: SPACE_WEATHER_UPDATE_MS,

    init(viewer) {
      if (_viewer)
        throw new Error(`${SPACE_WEATHER_LAYER_ID} already initialized`);
      _viewer = viewer;
      console.log('[Data:SpaceWeather] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      _viewer = viewer || _viewer;
      // No fetch here: the manager calls update() once enable() settles.
    },

    disable() {
      _enabled = false;
      _abort?.abort();
      _abort = null;
      clearPrimitives();
      // _lastError survives a disable, as elsewhere: the manager disables a
      // layer whose first update failed, and the row must still say why.
      _viewer?.scene?.requestRender?.();
    },

    async update() {
      return refresh();
    },

    destroy() {
      this.disable();
      _viewer = null;
      _rowControlsListener = null;
      _lastUpdate = null;
      _report = null;
    },

    getParams() {
      return {};
    },

    async setParams() {
      return false;
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** The latest report, for panels that want the numbers. */
    getSpaceWeather() {
      return _report;
    },

    getRowControls() {
      const legend = [];
      const r = _report;
      if (r?.kp)
        legend.push({
          label: kpText(r.kp.kp),
          blurb: `three-hourly index, ${r.kp.at?.slice(11, 16)}Z`,
        });
      if (r?.scales?.now) {
        const { R, S, G } = r.scales.now;
        legend.push({
          label: `G${G.level} ${G_SCALE_TEXT[G.level] || G.text}`,
          blurb: 'geomagnetic storm scale, SWPC now-cast',
        });
        legend.push({
          label: `R${R.level} ${R.text} · S${S.level} ${S.text}`,
          blurb:
            'radio blackout · solar radiation storm — an R2 is why HF went quiet',
        });
      }
      if (r?.aurora)
        legend.push({
          label: `aurora up to ${Math.round(r.aurora.max)}%`,
          blurb: `OVATION forecast for ${r.aurora.forecastAt?.slice(11, 16)}Z, from ${r.aurora.observedAt?.slice(11, 16)}Z data — a probability, not a sighting`,
        });
      for (const alert of (r?.alerts || []).slice(0, 2))
        legend.push({
          label: alert.headline.slice(0, 60),
          blurb: `${alert.code} · ${alert.at.slice(11, 16)}Z`,
        });
      return { chips: [], legend };
    },

    getStats() {
      const r = _report;
      return {
        count: r?.aurora?.cells.length ?? 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: r
          ? `${r.kp ? kpText(r.kp.kp) : 'Kp n/a'} · aurora ≤ ${Math.round(r.aurora.max)}% · fcst ${r.aurora.forecastAt?.slice(11, 16) ?? '--:--'}Z`
          : _lastError
            ? 'unavailable'
            : 'nothing drawn',
      };
    },

    getAnalystRecords() {
      const r = _report;
      if (!r) return [];
      return [
        {
          id: 'space-weather:now',
          layer: SPACE_WEATHER_LAYER_ID,
          kind: 'space-weather',
          label: r.kp ? kpText(r.kp.kp) : 'Space weather',
          detail: [
            r.scales?.now
              ? `G${r.scales.now.G.level} · R${r.scales.now.R.level} · S${r.scales.now.S.level}`
              : null,
            `aurora up to ${Math.round(r.aurora.max)}% (forecast ${r.aurora.forecastAt})`,
            ...(r.alerts || [])
              .slice(0, 3)
              .map((a) => `${a.code}: ${a.headline}`),
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ];
    },
  };
  return layer;
}

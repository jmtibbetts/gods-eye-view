import * as Cesium from 'cesium';
import {
  createLayerSelection,
  flatRingCentroid,
} from '../../data/layerSelection.js';
import {
  CONFLICT_REPORTS_ENTITY_PREFIX,
  CONFLICT_REPORTS_LAYER_ID,
  CONFLICT_UPDATE_MS,
} from './policy.js';
import { centroidShare, summarizeReports } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createConflictSource } from './source.js';

const entityId = (id) => `${CONFLICT_REPORTS_ENTITY_PREFIX}${id}`;

/** The readout card for one country. */
export function countryLabelText(area, summary) {
  const kinds = Object.entries(area.kinds || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ×${n}`)
    .join(', ');
  const lines = [`${area.country}: ${area.events} reported events`];
  if (kinds) lines.push(kinds);
  const share = centroidShare(area);
  if (share !== null && share > 0)
    // The single most important caveat, and it belongs on the country it
    // applies to rather than in a legend nobody reads.
    lines.push(
      `${share}% carried no location more precise than the country or a state.`,
    );
  if (summary?.windowMinutes)
    lines.push(`Last ${summary.windowMinutes} minutes of GDELT coverage.`);
  // Said on every card, deliberately. A shaded country reads as authoritative
  // unless it is told otherwise, and this data is neither verified nor evenly
  // collected.
  lines.push(
    'Machine-coded from news reporting — not verified incidents. Volume follows media attention as well as violence.',
  );
  return lines.join('\n');
}

/**
 * Conflict reporting, shaded by country.
 *
 * Whole countries, never points: see policy.js for why that is the only honest
 * rendering of this data.
 *
 * @param {object} options
 * @param {{fetchReports: Function}} options.source
 * @param {object} [options.context] contextStore module.
 */
export function createConflictReportsLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.fetchReports !== 'function')
    throw new TypeError('Conflict reports layer requires a source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  let _summary = summarizeReports(Object.assign([], { unmapped: [] }), null);
  /** @type {Map<string, object>} */
  const _areas = new Map();

  const selection = createLayerSelection({
    layerId: CONFLICT_REPORTS_LAYER_ID,
    layerName: 'Conflict Reporting',
    source: 'GDELT Project',
    entityPrefix: CONFLICT_REPORTS_ENTITY_PREFIX,
    context,
    getRecord: (id) => _areas.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    // A country is large; the card goes where the click landed.
    anchorCardAtClick: true,
    describe: (area) => {
      const c = flatRingCentroid(area.positions) || { lat: 0, lon: 0 };
      return {
        label: countryLabelText(area, _summary),
        latitude: c.lat,
        longitude: c.lon,
        properties: {
          country: area.country,
          events: area.events,
          band: area.bandName,
          centroidShare: centroidShare(area),
        },
      };
    },
    screenSpaceEventHandlerFactory,
  });

  function notifyRowControls() {
    try {
      _rowControlsListener?.();
    } catch {
      /* a listener failure must not break a refresh */
    }
  }

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _areas.clear();
  }

  function rebuild(areas) {
    if (!_dataSource) return;
    clearEntities();
    for (const area of areas) {
      const color = Cesium.Color.fromCssColorString(area.color);
      const entity = _dataSource.entities.add({
        id: entityId(area.id),
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(area.positions),
          ),
          // Light: this shades a country, it does not claim the ground.
          material: color.withAlpha(0.3),
          outline: true,
          outlineColor: color.withAlpha(0.8),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      // A polygon has no position of its own, and the readout needs one to
      // draw the card next to: the ring's centroid, until a click moves it.
      const centroid = flatRingCentroid(area.positions) || { lat: 0, lon: 0 };
      entity.gevTrackedId = entityId(area.id);
      entity.gevDisplayPosition = () =>
        Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, 0);
      entity.gevLabelModel = {
        title: `${area.country} · ${area.events} reported`,
        details: [],
        accent: area.color,
        cardStyle: 'tactical',
        selected: true,
      };
      _areas.set(area.id, area);
    }
    selection.reconcile();
    _summary = summarizeReports(areas, areas.payload);
  }

  async function refresh() {
    if (!_enabled) return false;
    _abort?.abort();
    _abort = new AbortController();
    try {
      const areas = await source.fetchReports({ signal: _abort.signal });
      if (!_enabled) return false;
      rebuild(areas);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:ConflictReports] load error:`, error);
      _lastError = error?.message || 'Conflict reporting unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: CONFLICT_REPORTS_LAYER_ID,
    name: 'Conflict Reporting',
    icon: '📰',
    source: 'GDELT Project',
    updateInterval: CONFLICT_UPDATE_MS,

    init(viewer) {
      if (_viewer)
        throw new Error(`${CONFLICT_REPORTS_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(CONFLICT_REPORTS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:ConflictReports] Initialized`);
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      // No fetch here. The manager calls update() the moment enable() settles,
      // so fetching in both meant every enable pulled the feed twice.
      selection.install(viewer || _viewer);
    },

    disable() {
      _enabled = false;
      _abort?.abort();
      _abort = null;
      selection.clear();
      selection.remove();
      clearEntities();
      if (_dataSource) _dataSource.show = false;
      // _lastError deliberately SURVIVES a disable. The manager disables a
      // layer whose first update returned false, which is exactly what a
      // failed fetch does — so clearing the error here is what turns "the
      // upstream is down" into a layer that quietly switched itself off and
      // reports nothing in scope. A later successful refresh clears it.
      _viewer?.scene?.requestRender?.();
    },

    async update() {
      return refresh();
    },

    destroy() {
      this.disable();
      if (_dataSource && _viewer?.dataSources) {
        try {
          _viewer.dataSources.remove(_dataSource, true);
        } catch {
          /* scene may already be tearing down */
        }
      }
      _dataSource = null;
      _viewer = null;
      _rowControlsListener = null;
      _lastUpdate = null;
    },

    getRowControls() {
      const legend = _summary.breakdown.map((entry) => ({
        label: `${entry.name} ×${entry.count}`,
        blurb: null,
      }));
      // A country the feed reported but the boundary set has no shape for is
      // named in the legend. Silently missing and nothing-to-report look
      // identical on a map, and only one of them is true.
      if (_summary.unmapped?.length)
        legend.push({
          label: `${_summary.unmapped.length} unmapped (${_summary.unmappedEvents})`,
          blurb: _summary.unmapped
            .map((u) => `${u.code} ×${u.events}`)
            .join(', '),
        });
      return { chips: [], legend };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _summary.countries,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // "Reported" is in the string on purpose: this is a count of coverage,
        // not a count of incidents.
        coverage: _summary.countries
          ? `${_summary.events} reported in ${_summary.countries} countries · ${_summary.windowMinutes}m`
          : _lastError
            ? 'unavailable'
            : 'no violent events in the last update',
      };
    },

    getAnalystRecords() {
      const seen = new Set();
      const records = [];
      for (const area of _areas.values()) {
        // One country can be several polygons; the analyst wants one row.
        if (seen.has(area.code)) continue;
        seen.add(area.code);
        records.push({
          id: area.code,
          layer: CONFLICT_REPORTS_LAYER_ID,
          kind: 'conflict-reporting',
          label: `${area.country}: ${area.events} reported events`,
          detail: countryLabelText(area, _summary),
        });
      }
      return records;
    },
  };
  return layer;
}

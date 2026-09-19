import * as Cesium from 'cesium';
import { isPointerFree } from './inputOwnership.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';

/**
 * Click-to-select for a data layer's entities.
 *
 * This is the selection subsystem the established layers — storm reports,
 * weather alerts, volcanoes — each carry inline: a LEFT_CLICK handler that
 * picks the scene, recognises this layer's entities by id prefix, publishes
 * the picked record to the context store so the readout card appears, clears
 * on Escape or on a click elsewhere, and registers pick ownership so other
 * layers do not clear a selection they do not own.
 *
 * Nine layers were shipped without it. Their entities drew, their cards were
 * written, and clicking any of them did nothing: `gevLabelModel` only reaches
 * the readout once an entity has been SELECTED, and nothing selected it.
 *
 * One implementation rather than a tenth copy, in the same way pickRegistry
 * and inputOwnership are already shared: the behaviour is the established
 * layers' behaviour exactly, each layer supplying only how to find a record
 * and how to describe it.
 *
 * @param {object} options
 * @param {string} options.layerId
 * @param {string} options.layerName Shown on the readout card.
 * @param {string} options.source Attribution shown on the readout card.
 * @param {string} options.entityPrefix The prefix every entity id carries.
 * @param {object|null} options.context contextStore module, or null.
 * @param {(id: string) => any} options.getRecord Record by bare id, or falsy.
 * @param {(id: string) => any} options.getEntity Entity by bare id, or falsy.
 * @param {() => any} options.getDataSource The layer's CustomDataSource.
 * @param {(record: any) => {label: string, latitude: number, longitude: number, properties?: object}} options.describe
 * @param {boolean} [options.anchorCardAtClick=false] Draw the readout card
 *   at the clicked ground position rather than the entity's own anchor. For
 *   an area — an outlook, a drought band, a shaded country — the entity's
 *   anchor is its centroid, which for anything continent-sized is usually off
 *   screen from where the click landed, and a card placed there is never seen.
 * @param {(viewer:any) => Cesium.ScreenSpaceEventHandler} [options.screenSpaceEventHandlerFactory]
 */
export function createLayerSelection({
  layerId,
  layerName,
  source,
  entityPrefix,
  context = null,
  getRecord,
  getEntity,
  getDataSource,
  describe,
  anchorCardAtClick = false,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
}) {
  let _clickHandler = null;
  let _keyHandler = null;
  let _selectedId = null;

  const entityId = (id) => `${entityPrefix}${id}`;

  /**
   * @param {string} id Bare record id.
   * @param {object} [options]
   * @param {any} [options.anchor] World position to draw the card at. Set
   *   before the selection is published, because the readout reads the
   *   entity's anchor the moment the selection event fires.
   */
  function select(id, { anchor = null } = {}) {
    const record = getRecord(id);
    const entity = getEntity(id);
    if (!record || !entity || !context) return false;
    _selectedId = id;
    if (anchor) entity.gevDisplayPosition = () => anchor;
    try {
      const described = describe(record);
      context.registerEntityContext(entity, {
        id: entityId(id),
        layerId,
        layerName,
        source,
        dataSource: getDataSource(),
        label: described.label,
        latitude: described.latitude,
        longitude: described.longitude,
        properties: described.properties || {},
      });
      context.selectEntityContext(entity);
    } catch {
      /* context store unavailable — entities still render */
    }
    return true;
  }

  function clear() {
    _selectedId = null;
    try {
      context?.clearSelectedEntityContextForLayer?.(layerId);
    } catch {
      /* ignore */
    }
  }

  function install(viewer) {
    if (_clickHandler || !viewer?.scene?.canvas) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      if (typeof pickedId === 'string' && pickedId.startsWith(entityPrefix)) {
        const id = pickedId.slice(entityPrefix.length);
        if (getRecord(id)) {
          select(id, {
            anchor: anchorCardAtClick
              ? groundPosition(viewer, click.position)
              : null,
          });
          return;
        }
      }
      if (isOwnedByOtherLayer(layerId, pickedId)) return;
      if (_selectedId) clear();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _keyHandler = (event) => {
      if (event.key === 'Escape' && _selectedId) clear();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('keydown', _keyHandler);
    registerPickOwner(
      layerId,
      (id) => typeof id === 'string' && id.startsWith(entityPrefix),
    );
  }

  function remove() {
    _clickHandler?.destroy();
    _clickHandler = null;
    if (_keyHandler && typeof document !== 'undefined')
      document.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
    unregisterPickOwner(layerId);
  }

  /**
   * After a rebuild, a selected record may no longer exist. Dropping the
   * selection then keeps the readout from describing something that is not
   * on the globe any more.
   */
  function reconcile() {
    if (_selectedId && !getRecord(_selectedId)) clear();
  }

  return {
    select,
    clear,
    install,
    remove,
    reconcile,
    selectedId: () => _selectedId,
  };
}

/**
 * The ground under a screen position: terrain where it is loaded, the
 * ellipsoid otherwise, null when the click missed the globe.
 */
function groundPosition(viewer, position) {
  try {
    const scene = viewer.scene;
    const ray = viewer.camera.getPickRay(position);
    const onTerrain = ray ? scene.globe?.pick?.(ray, scene) : null;
    if (onTerrain) return onTerrain;
    return (
      viewer.camera.pickEllipsoid(position, scene.globe?.ellipsoid) || null
    );
  } catch {
    return null;
  }
}

/**
 * Rough centroid of a flat [lon, lat, …] ring, for the readout's position.
 *
 * The same arithmetic the weather-alerts layer uses for its polygons. Good
 * enough to place a card and fly a camera; not a geometric centroid, and not
 * presented as one.
 *
 * @param {number[]} flat
 * @returns {{lat: number, lon: number}|null}
 */
export function flatRingCentroid(flat) {
  if (!Array.isArray(flat) || flat.length < 6) return null;
  let lon = 0;
  let lat = 0;
  const n = flat.length / 2;
  for (let i = 0; i < flat.length; i += 2) {
    lon += flat[i];
    lat += flat[i + 1];
  }
  return { lon: lon / n, lat: lat / n };
}

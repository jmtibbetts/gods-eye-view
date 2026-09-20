import * as Cesium from 'cesium';
import { cameraPoseSignature } from '../../data/iconOrientation.js';
import { importJsonPack } from '../../data/naturalEarthRegions.js';
import { createRetryableLoader } from '../../data/retryableLoad.js';
import {
  PLACE_NAMES_COHORT_LIMIT,
  PLACE_NAMES_COLLISION_CAPACITY,
  PLACE_NAMES_LAYER_ID,
  PLACE_NAMES_OVERLAY_SOURCE_ID,
  PLACE_NAMES_VIEW_TICK_MS,
  PLACE_TIERS,
  tiersForHeight,
} from './policy.js';
import { buildPlaces, visiblePlaces } from './records.js';

export * from './policy.js';
export * from './records.js';

const tierById = new Map(PLACE_TIERS.map((tier) => [tier.id, tier]));

/**
 * Default pack loader. See `importJsonPack` for why each pack is asked for
 * twice: Node wants the JSON import attribute and Vite refuses it.
 */
async function loadBundledPacks() {
  const [anchors, places, countries] = await Promise.all([
    importJsonPack(
      () => import('../../data/local_data/natural_earth_places/anchors.json'),
      () =>
        import('../../data/local_data/natural_earth_places/anchors.json', {
          with: { type: 'json' },
        }),
    ),
    importJsonPack(
      () => import('../../data/local_data/natural_earth_places/places.json'),
      () =>
        import('../../data/local_data/natural_earth_places/places.json', {
          with: { type: 'json' },
        }),
    ),
    // The outlines, for "which country is the middle of the screen in". The
    // country pack is the small one — a twentieth of the region pack — and it
    // is the only tier where the answer has to be exactly right.
    importJsonPack(
      () =>
        import('../../data/local_data/natural_earth_countries/countries.json'),
      () =>
        import('../../data/local_data/natural_earth_countries/countries.json', {
          with: { type: 'json' },
        }),
    ),
  ]);
  return { anchors, places, countries };
}

/**
 * Place names — what you are looking at, written on it.
 *
 * Google 3D, Esri Satellite and Bing Aerial all ship without a single label;
 * only Bing Labels and OSM carry their own. So on the basemaps this app
 * defaults to, nothing on the planet was named — you could fly to a coastline
 * and have no way to tell which country it was.
 *
 * WHY THESE ARE NOT ENTITIES. A Cesium label is a billboard in the scene, and
 * a billboard on a globe has to be told about the horizon, the depth buffer
 * and its neighbours, or it draws through the Earth and piles up on its own
 * kind. The world overlay already solves all three for the labels this app
 * draws — it projects, culls to the horizon, and resolves collisions across
 * every ambient label on screen. So this layer owns no scene objects at all:
 * it hands the overlay a list of points and names on a camera tick, and the
 * host draws them. That is also why it works identically on Google 3D, where
 * the globe is hidden and a depth-tested label would be wrong.
 *
 * @param {object} options
 * @param {{setEntries:Function,setVisible:Function,clearSource:Function}} options.overlayHost
 *   Injected rather than imported: the host lives in the application layer,
 *   and a layer that reaches up into it drags the whole app into its own
 *   dependency boundary.
 * @param {() => Promise<{anchors:object, places:object}>} [options.loadPacks]
 * @param {{set:Function, clear:Function}} [options.timers]
 */
export function createPlaceNamesLayer({
  overlayHost,
  loadPacks = loadBundledPacks,
  timers = {
    set: (fn, ms) => globalThis.setInterval(fn, ms),
    clear: (id) => globalThis.clearInterval(id),
  },
} = {}) {
  if (!overlayHost?.setEntries)
    throw new TypeError('Place names need a world-overlay host');
  let _viewer = null;
  let _enabled = false;
  let _places = null;
  let _lastError = null;
  let _lastUpdate = null;
  let _viewTimer = null;
  let _poseSignature = null;
  let _shown = 0;
  let _generation = 0;
  /** Country outlines, for naming the country the view is inside. */
  let _countries = null;

  const loader = createRetryableLoader(async () => {
    const packs = await loadPacks();
    _countries = packs.countries || null;
    return buildPlaces(packs);
  });

  /** The camera's box in degrees, or null when it is not on the planet. */
  function viewExtent() {
    const rectangle = _viewer?.camera?.computeViewRectangle?.(
      _viewer.scene?.globe?.ellipsoid,
    );
    if (!rectangle) return null;
    const degrees = (radians) => (radians * 180) / Math.PI;
    return {
      west: degrees(rectangle.west),
      south: degrees(rectangle.south),
      east: degrees(rectangle.east),
      north: degrees(rectangle.north),
    };
  }

  /**
   * Re-choose the names on screen.
   * @param {{force?: boolean}} [options] Force past the camera-still check.
   */
  function refresh({ force = false } = {}) {
    const camera = _viewer?.camera;
    if (!_enabled || !_places || !camera?.positionWC) return false;
    const signature = cameraPoseSignature(camera);
    if (!force && signature === _poseSignature) return false;
    _poseSignature = signature;
    const heightM = camera.positionCartographic?.height ?? 0;
    const cohort = visiblePlaces({
      places: _places,
      heightM,
      view: viewExtent(),
      limit: PLACE_NAMES_COHORT_LIMIT,
      countries: _countries,
    }).map((place) => ({
      id: `${PLACE_NAMES_OVERLAY_SOURCE_ID}:${place.id}`,
      position: Cesium.Cartesian3.fromDegrees(place.lon, place.lat, 0),
      variant: 'label',
      title: place.name,
      accent: tierById.get(place.tier)?.accent || '#ffffff',
      priority: place.priority,
      paintLane: 'ambient-label',
      interactive: false,
      edgeFade: 'keyhole',
      // The one thing a name on a planet must never do is appear on the wrong
      // side of it.
      horizonCull: true,
      // A place name belongs on the ground it names, not above the terrain in
      // front of it — and under Google 3D there is no globe depth to test.
      terrainOcclusion: false,
      gapPx: 0,
      verticalOnly: true,
      placement: 'above',
    }));
    _shown = cohort.length;
    overlayHost.setEntries(PLACE_NAMES_OVERLAY_SOURCE_ID, cohort, {
      cohortLimit: PLACE_NAMES_COHORT_LIMIT,
      collisionCapacity: PLACE_NAMES_COLLISION_CAPACITY,
      moving: false,
    });
    _viewer?.scene?.requestRender?.();
    return true;
  }

  function startViewTicks() {
    if (_viewTimer != null) return;
    _viewTimer = timers.set(() => refresh(), PLACE_NAMES_VIEW_TICK_MS);
  }

  function stopViewTicks() {
    if (_viewTimer != null) timers.clear(_viewTimer);
    _viewTimer = null;
    _poseSignature = null;
  }

  function clearOverlay() {
    _shown = 0;
    try {
      overlayHost.clearSource(PLACE_NAMES_OVERLAY_SOURCE_ID);
    } catch {
      /* the scene may already be tearing down */
    }
  }

  return {
    id: PLACE_NAMES_LAYER_ID,
    name: 'Place Names',
    icon: '🏷️',
    source: 'Natural Earth',
    // The packs are bundled and the world does not move: there is nothing to
    // poll for. The camera tick is what keeps this current.
    updateInterval: 0,

    init(viewer) {
      if (_viewer)
        throw new Error(`${PLACE_NAMES_LAYER_ID} already initialized`);
      _viewer = viewer;
      console.log('[Data:PlaceNames] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      _viewer = viewer || _viewer;
      overlayHost.setVisible?.(PLACE_NAMES_OVERLAY_SOURCE_ID, true);
      startViewTicks();
    },

    disable() {
      _enabled = false;
      stopViewTicks();
      clearOverlay();
      _viewer?.scene?.requestRender?.();
    },

    /**
     * Load the packs if they are not loaded, then draw. Called once by the
     * manager after enable, and never on a timer — see `updateInterval`.
     */
    async update() {
      if (!_enabled) return false;
      const generation = ++_generation;
      try {
        const places = await loader();
        if (!_enabled || generation !== _generation) return false;
        _places = places;
        _lastUpdate = Date.now();
        _lastError = null;
      } catch (error) {
        if (generation !== _generation) return false;
        _lastError = error?.message || 'place names unavailable';
        return false;
      }
      return refresh({ force: true });
    },

    destroy() {
      this.disable();
      _places = null;
      _countries = null;
      _viewer = null;
      _lastUpdate = null;
    },

    getStats() {
      const heightM = _viewer?.camera?.positionCartographic?.height ?? 0;
      const live = tiersForHeight(heightM);
      return {
        count: _shown,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _lastError
          ? 'names unavailable'
          : !_places
            ? 'loading names'
            : live.length
              ? `${_shown} shown · ${live.map((tier) => tier.label.toLowerCase()).join(', ')}`
              : `${_places.length} names`,
      };
    },
  };
}

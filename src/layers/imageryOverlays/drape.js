import * as Cesium from 'cesium';

/**
 * Paints an imagery product onto a surface that is not the globe.
 *
 * WHY THIS EXISTS. Cesium's imagery layers paint on the globe, and the
 * photoreal map stack hides the globe outright and draws Google's 3D tiles
 * instead. For a long time the conclusion drawn from that was that imagery
 * and Google 3D cannot share a surface, so turning an overlay on took the
 * basemap away from the user to give them something the overlay could be
 * seen on.
 *
 * That conclusion was too broad. An imagery LAYER cannot draw there. An
 * image can: a rectangle whose material is an image and whose
 * classificationType is CESIUM_3D_TILE is draped onto the rendered tiles
 * themselves, following the geometry — over a city it wraps the buildings.
 * The same trick the weather-alert polygons already use to lie on the
 * photoreal surface works with a picture instead of a colour.
 *
 * What it needs is a picture. A tile pyramid is not one, which is why the
 * imagery-layer path cannot be reused — but every product in the catalog is
 * also a WMS layer, and WMS answers an arbitrary box with a single image.
 * So a drape is one request for what the camera can currently see, redone
 * when the camera settles somewhere else.
 *
 * THE TRADE, said plainly: a drape is one image sized to the window, where
 * an imagery layer is a pyramid that refines as you go in. On the globe
 * stacks the layer is sharper and cheaper and is still what runs. The drape
 * is for the surface where the alternative was not a coarser picture but no
 * picture and no basemap either.
 */

/** Longest side of a requested image. Beyond this the wire cost stops buying detail. */
const MAX_PIXELS = 2048;
/** Shortest side worth asking for. */
const MIN_PIXELS = 256;
/** Fraction of the view's span added to each edge, so a small pan shows no seam. */
const EDGE_PAD = 0.1;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * The box to ask for, in degrees, padded and clamped to a legal extent.
 *
 * A view that crosses the antimeridian has west greater than east, which no
 * single GetMap box can express. That only happens looking at most of the
 * planet at once, where the whole planet is the honest answer anyway.
 *
 * @param {{west: number, south: number, east: number, north: number}} view
 *   The view rectangle in DEGREES.
 * @returns {{west: number, south: number, east: number, north: number}}
 */
export function drapeExtent(view) {
  const south = clamp(view.south, -90, 90);
  const north = clamp(view.north, -90, 90);
  const padY = (north - south) * EDGE_PAD;
  if (!(view.east > view.west))
    return {
      west: -180,
      east: 180,
      south: clamp(south - padY, -90, 90),
      north: clamp(north + padY, -90, 90),
    };
  const padX = (view.east - view.west) * EDGE_PAD;
  return {
    west: clamp(view.west - padX, -180, 180),
    east: clamp(view.east + padX, -180, 180),
    south: clamp(south - padY, -90, 90),
    north: clamp(north + padY, -90, 90),
  };
}

/**
 * Pixel dimensions for an extent, shaped like the box and capped like a
 * screen. Asking for more pixels than the window can show buys nothing.
 *
 * @param {{west: number, south: number, east: number, north: number}} extent
 * @param {number} [canvasLongSide] The window's longest side in pixels.
 * @returns {{width: number, height: number}}
 */
export function drapePixels(extent, canvasLongSide = MAX_PIXELS) {
  const spanX = Math.max(1e-6, extent.east - extent.west);
  const spanY = Math.max(1e-6, extent.north - extent.south);
  const cap = clamp(Math.round(canvasLongSide), MIN_PIXELS, MAX_PIXELS);
  const wide = spanX >= spanY;
  const long = cap;
  const short = clamp(
    Math.round(cap * (wide ? spanY / spanX : spanX / spanY)),
    MIN_PIXELS,
    MAX_PIXELS,
  );
  return wide ? { width: long, height: short } : { width: short, height: long };
}

/**
 * Build the GetMap URL for one drape.
 *
 * WMS 1.3.0 with EPSG:4326 orders the box latitude first — south, west,
 * north, east. Getting that backwards returns an image of somewhere else
 * rather than an error, so it is written once, here.
 *
 * @param {{url: string, layers: string, parameters?: Record<string,string>}} source
 * @param {{west: number, south: number, east: number, north: number}} extent
 * @param {{width: number, height: number}} pixels
 * @returns {string}
 */
export function drapeRequestUrl(source, extent, pixels) {
  const query = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    LAYERS: source.layers,
    CRS: 'EPSG:4326',
    BBOX: [extent.south, extent.west, extent.north, extent.east].join(','),
    WIDTH: String(pixels.width),
    HEIGHT: String(pixels.height),
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    ...(source.parameters || {}),
  });
  return `${source.url}${source.url.includes('?') ? '&' : '?'}${query}`;
}

/**
 * Create a drape bound to one viewer.
 *
 * The caller decides WHEN to drape — the surface state is not this module's
 * business. It is told a source and a box and it puts a picture there.
 *
 * @param {object} options
 * @param {object} options.viewer A Cesium viewer.
 * @param {string} options.id Entity id stem, so two overlays never collide.
 * @param {(url: string) => Promise<unknown>} [options.loadImage] Injectable;
 *   resolves once the picture is decoded and will not flash when shown.
 * @param {typeof Cesium} [options.cesium] Injectable for tests.
 */
export function createImageryDrape({
  viewer,
  id,
  loadImage = defaultLoadImage,
  cesium = Cesium,
} = {}) {
  if (!viewer) throw new TypeError('A drape needs a viewer');
  if (!id) throw new TypeError('A drape needs an id');

  let _source = null;
  let _alpha = 1;
  let _entity = null;
  let _request = 0;
  let _destroyed = false;
  let _lastError = null;
  let _removeMoveEnd = null;

  /** The camera's box in degrees, or null when it is not looking at the planet. */
  function viewExtent() {
    const scene = viewer.scene;
    const rectangle = viewer.camera?.computeViewRectangle?.(
      scene?.globe?.ellipsoid,
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

  function canvasLongSide() {
    const canvas = viewer.scene?.canvas;
    const width = Number(canvas?.clientWidth) || 0;
    const height = Number(canvas?.clientHeight) || 0;
    return Math.max(width, height) || MAX_PIXELS;
  }

  function removeEntity(entity) {
    if (!entity) return;
    try {
      viewer.entities.remove(entity);
    } catch {
      /* the scene may already be tearing down */
    }
  }

  /**
   * Fetch the picture for the current view and put it on the surface.
   *
   * The old picture stays up until the new one has decoded. A drape that
   * cleared itself first would blink the surface bare on every pan, which is
   * the complaint this whole path exists to answer.
   *
   * @returns {Promise<boolean>} Whether a picture was placed.
   */
  async function refresh() {
    if (_destroyed || !_source) return false;
    const token = ++_request;
    const view = viewExtent();
    if (!view) return false;
    const extent = drapeExtent(view);
    const pixels = drapePixels(extent, canvasLongSide());
    const url = drapeRequestUrl(_source, extent, pixels);
    try {
      await loadImage(url);
    } catch (error) {
      if (token !== _request || _destroyed) return false;
      _lastError = error?.message || 'imagery could not be drawn on this map';
      return false;
    }
    if (token !== _request || _destroyed) return false;
    const previous = _entity;
    _entity = viewer.entities.add({
      id: `${id}#drape#${token}`,
      rectangle: {
        coordinates: cesium.Rectangle.fromDegrees(
          extent.west,
          extent.south,
          extent.east,
          extent.north,
        ),
        material: new cesium.ImageMaterialProperty({
          image: url,
          color: cesium.Color.WHITE.withAlpha(_alpha),
          transparent: true,
        }),
        classificationType: cesium.ClassificationType.CESIUM_3D_TILE,
      },
    });
    removeEntity(previous);
    _lastError = null;
    viewer.scene?.requestRender?.();
    return true;
  }

  function listen() {
    if (_removeMoveEnd || !viewer.camera?.moveEnd?.addEventListener) return;
    _removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
      if (!_destroyed && _source) void refresh();
    });
  }

  return {
    /**
     * Point the drape at a product and draw it.
     * @param {{url: string, layers: string, parameters?: Record<string,string>}} source
     * @param {{alpha?: number}} [options]
     * @returns {Promise<boolean>}
     */
    async show(source, { alpha = 1 } = {}) {
      if (_destroyed || !source?.url || !source?.layers) return false;
      _source = source;
      _alpha = alpha;
      listen();
      return refresh();
    },

    refresh,

    /** Take the picture down without ending the drape's life. */
    clear() {
      _request++;
      _source = null;
      removeEntity(_entity);
      _entity = null;
      viewer.scene?.requestRender?.();
    },

    /** Whether a picture is currently on the surface. */
    isShowing() {
      return Boolean(_entity);
    },

    getLastError() {
      return _lastError;
    },

    destroy() {
      if (_destroyed) return;
      _destroyed = true;
      _request++;
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      removeEntity(_entity);
      _entity = null;
      _source = null;
    },
  };
}

/**
 * Decode a picture before it is handed to the renderer, so the swap onto the
 * surface is instant and a failed request is a rejection rather than a
 * silently empty rectangle.
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function defaultLoadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error('imagery frame could not be loaded'));
    image.src = url;
  });
}

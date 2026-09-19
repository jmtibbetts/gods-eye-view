/**
 * Keeps the globe surface in a state where imagery overlays can actually be
 * seen.
 *
 * THE PROBLEM THIS SOLVES. Cesium imagery layers paint onto the globe's
 * surface. The photoreal map stack (Google 3D Tiles) hides the globe outright
 * — `globe.show = false` in the map controller — and draws a tileset instead.
 * So with photoreal active, an imagery overlay is not merely hard to see: it
 * is completely inert. The browser issues no tile requests at all, nothing is
 * drawn, no error is raised, and the layer's own stats look perfectly healthy.
 * A user toggling "Satellite Imagery" on the default basemap got silence.
 *
 * Rather than let that stand, enabling any imagery overlay borrows the surface:
 * the first one to turn on switches to a globe stack, and the last one to turn
 * off puts the previous stack back. That trade is real and worth naming to the
 * user — you give up the photorealistic 3D to see the imagery, because the two
 * cannot occupy the same surface — so the caller is told what happened and the
 * panel says it out loud.
 *
 * Counting lives here, at module scope, rather than in the panel, because the
 * slots can also be toggled from the DATA LAYERS list, a combination preset or
 * a restored share link. A coordinator that only knew about panel clicks would
 * leave those paths silently dead again.
 */

/** Globe stacks we would rather borrow, best first. */
const PREFERRED_STACKS = Object.freeze([
  'esri-imagery',
  'bing-aerial',
  'osm',
  'bing-labels',
]);

/** Fired on the event target when the surface had to be taken back. */
export const IMAGERY_SURFACE_RECLAIMED_EVENT = 'gev:imagery-surface-reclaimed';

/**
 * Create a surface coordinator. Exported for tests; the module-level
 * `imagerySurface` is the one the layers share.
 *
 * Borrowing once is not enough: a share-link restore, a saved visual state
 * or the map tray can put the photoreal stack back while overlays are still
 * on, and every one of them then draws nothing, silently, with healthy
 * stats. So the coordinator also listens for stack changes and, while it
 * holds the surface, takes it back the moment the globe is hidden — and
 * announces that it did, so the user learns why Google 3D will not stay.
 * @param {{eventTarget?: EventTarget|null}} [options] Where stack-change
 *   events arrive and the reclaimed event is dispatched (the window).
 */
export function createSurfaceCoordinator({
  eventTarget = globalThis.window ?? null,
} = {}) {
  let controller = null;
  let holders = 0;
  /** The stack we switched away from, or null when we did not switch. */
  let restoreTo = null;
  /** The stack we switched TO, so we never fight a later manual change. */
  let borrowed = null;
  let reconciling = false;
  let listening = false;

  function globeHidden() {
    try {
      return controller?.viewer?.scene?.globe?.show === false;
    } catch {
      return false;
    }
  }

  function pickStack() {
    if (!controller) return null;
    for (const id of PREFERRED_STACKS) {
      try {
        if (controller.isStackAvailable?.(id)) return id;
      } catch {
        /* availability is best-effort */
      }
    }
    // Fall back to any stack that is not the photoreal one.
    try {
      const stacks = controller.getStacks?.() || [];
      const other = stacks
        .map((s) => s?.id ?? s)
        .find((id) => id && id !== 'photoreal');
      return other || null;
    } catch {
      return null;
    }
  }

  /**
   * The surface was taken away while overlays hold it: borrow it again.
   * Not silent — the map tray's lit chip must follow the stack that is
   * actually active, or the user is lied to twice.
   * @returns {Promise<{reclaimed: boolean, from: string|null, to: string|null}>}
   */
  async function reconcile() {
    if (reconciling || holders === 0 || !controller || !globeHidden())
      return { reclaimed: false, from: null, to: null };
    reconciling = true;
    try {
      const from = controller.getActiveId?.() ?? null;
      const to = pickStack();
      if (!to || to === from) return { reclaimed: false, from, to: null };
      await controller.setStack(to);
      restoreTo = from;
      borrowed = to;
      if (typeof CustomEvent === 'function')
        eventTarget?.dispatchEvent?.(
          new CustomEvent(IMAGERY_SURFACE_RECLAIMED_EVENT, {
            detail: { from, to, holders },
          }),
        );
      return { reclaimed: true, from, to };
    } catch {
      return { reclaimed: false, from: null, to: null };
    } finally {
      reconciling = false;
    }
  }

  function listen() {
    if (listening || !eventTarget?.addEventListener) return;
    listening = true;
    eventTarget.addEventListener('gev:map-stack-changed', (event) => {
      // 'switching' fires before the globe changes; 'ready' is the truth.
      const status = event?.detail?.status;
      if (status && status !== 'ready') return;
      void reconcile();
    });
  }

  return {
    attach(next) {
      controller = next || null;
      listen();
    },

    reconcile,

    /** Test seam. */
    _state() {
      return { holders, restoreTo, borrowed };
    },

    /**
     * Claim the surface for an overlay that is turning on.
     * @returns {Promise<{switched: boolean, from: string|null, to: string|null}>}
     */
    async retain() {
      holders += 1;
      if (holders !== 1 || !controller || !globeHidden())
        return { switched: false, from: null, to: null };
      const from = controller.getActiveId?.() ?? null;
      const to = pickStack();
      if (!to || to === from) return { switched: false, from, to: null };
      try {
        await controller.setStack(to, { silent: true });
      } catch {
        return { switched: false, from, to: null };
      }
      restoreTo = from;
      borrowed = to;
      return { switched: true, from, to };
    },

    /**
     * Give the surface back when an overlay turns off. Only the last holder
     * restores, and only if nobody has since chosen a different stack by hand —
     * silently yanking a user's deliberate choice would be worse than leaving
     * the borrowed one in place.
     * @returns {Promise<{restored: boolean, to: string|null}>}
     */
    async release() {
      holders = Math.max(0, holders - 1);
      if (holders !== 0 || !controller || !restoreTo)
        return { restored: false, to: null };
      const target = restoreTo;
      const current = controller.getActiveId?.() ?? null;
      restoreTo = null;
      const wasOurs = borrowed === null || current === borrowed;
      borrowed = null;
      if (!wasOurs) return { restored: false, to: null };
      try {
        await controller.setStack(target, { silent: true });
      } catch {
        return { restored: false, to: null };
      }
      return { restored: true, to: target };
    },

    /** Drop all state — used when the scene is torn down. */
    reset() {
      holders = 0;
      restoreTo = null;
      borrowed = null;
    },
  };
}

/** The coordinator every imagery overlay layer shares. */
export const imagerySurface = createSurfaceCoordinator();

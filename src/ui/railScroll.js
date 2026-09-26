/**
 * Scrolling the right rail's section scrollers without losing the scroll to
 * the rail's own layout passes.
 *
 * A layout pass measures each panel at its natural height by lifting the
 * max-height of every `data-rail-scroller`, which clamps the scroller's offset
 * to zero — and a clamp cancels a smooth scroll in flight. The pass then puts
 * back the offset it saw before measuring, which is where the scroll STARTED.
 * Opening a section usually changes the rail's content, so a pass nearly always
 * lands inside the animation, and the section the user asked for never
 * arrives.
 *
 * Recording where a scroll is headed lets the pass put the scroller at the
 * destination instead. Without a pass the smooth scroll simply finishes.
 */

/** @type {WeakMap<Element, {top: number, clear: () => void}>} */
const pending = new WeakMap();

/** How long a destination is honoured if the scroll never reports its end. */
const PENDING_MS = 1500;

/**
 * Scroll `scroller` to `top`, keeping the destination through layout passes.
 * @param {Element} scroller A `data-rail-scroller` element.
 * @param {number} top Destination scrollTop.
 * @param {{smooth?: boolean}} [options]
 * @returns {number} The clamped destination.
 */
export function scrollRailTo(scroller, top, { smooth = true } = {}) {
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const target = Math.min(max, Math.max(0, top));
  pending.get(scroller)?.clear();
  if (smooth) {
    let timer = null;
    const onEnd = () => {
      if (Math.abs(scroller.scrollTop - target) < 1) clear();
    };
    const clear = () => {
      if (pending.get(scroller)?.clear === clear) pending.delete(scroller);
      if (timer !== null) clearTimeout(timer);
      scroller.removeEventListener?.('scrollend', onEnd);
    };
    pending.set(scroller, { top: target, clear });
    scroller.addEventListener?.('scrollend', onEnd);
    timer = setTimeout(clear, PENDING_MS);
  }
  scroller.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
  return target;
}

/**
 * Where a smooth rail scroll on `scroller` is headed, if one is in flight.
 * @param {Element} scroller
 * @returns {number|undefined}
 */
export function pendingRailScroll(scroller) {
  return pending.get(scroller)?.top;
}

/**
 * The rail scroller that actually scrolls `element`: the nearest
 * `data-rail-scroller` ancestor with scrollable overflow. The Context rail has
 * two tagged wrappers and which one scrolls depends on the HUD theme.
 * @param {Element} element
 * @returns {Element|null}
 */
export function railScrollerFor(element) {
  for (
    let node = element?.parentElement?.closest?.('[data-rail-scroller]');
    node;
    node = node.parentElement?.closest?.('[data-rail-scroller]')
  ) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      (overflow === 'auto' || overflow === 'scroll') &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return null;
}

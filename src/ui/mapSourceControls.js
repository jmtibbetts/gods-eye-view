import { renderMapStackChips, syncMapStackChips } from '../mapStackChips.js';

/**
 * Own Map Source presentation and selection without constructing map providers.
 * The supplied controller remains authoritative for availability and active state.
 */
export function createMapSourceControls({
  container,
  statusElement,
  controller,
  subscribe,
  claimSelection = () => {},
  onStateChanged = () => {},
  onError = () => {},
}) {
  let destroyed = false;
  let generation = 0;
  let reportedError = null;
  const removers = [];
  // The controller can change the map without being asked: a surface whose
  // tiles stop arriving falls back so the planet does not vanish. That has to
  // say so, or the basemap silently becomes a different one. Every state we
  // observe reports its error once; the controller clears the error at the
  // start of each switch, so the same message recurring is announced again.
  const reportError = (message) => {
    if (!message) {
      reportedError = null;
      return;
    }
    if (message === reportedError) return;
    reportedError = message;
    onError(message);
  };
  const bind = (element, type, listener) => {
    element.addEventListener(type, listener);
    removers.push(() => element.removeEventListener(type, listener));
  };
  function render(state) {
    if (destroyed || !state) return;
    syncMapStackChips(container, state.activeId);
    if (statusElement) {
      const stack = state.activeStack;
      statusElement.textContent =
        state.status === 'switching'
          ? '...'
          : stack?.shortLabel || stack?.label || 'MAP';
      statusElement.classList.toggle('warn', !!state.lastError);
    }
  }
  async function select(stackId, { syncShare = true } = {}) {
    if (destroyed) return null;
    const current = ++generation;
    if (syncShare) claimSelection();
    const before = controller.getActiveId();
    render(controller.getState('switching'));
    let state;
    try {
      state = await controller.setStack(stackId);
    } catch (error) {
      if (!destroyed && current === generation) {
        render(controller.getState());
        reportError(error?.message || String(error));
      }
      throw error;
    }
    if (destroyed || current !== generation) return state;
    const settled = controller.getState();
    render(settled);
    reportError(settled.lastError);
    if (syncShare) onStateChanged();
    return state;
  }
  function refresh() {
    if (destroyed) return;
    for (const remove of removers.splice(0)) remove();
    renderMapStackChips(container, controller.getStacks(), {
      activeId: controller.getActiveId(),
      onSelect: (id) => {
        void select(id).catch(() => {});
      },
      bind,
    });
    const state = controller.getState();
    render(state);
    reportError(state.lastError);
  }
  const unsubscribe = subscribe(() => {
    if (destroyed) return;
    const state = controller.getState();
    render(state);
    reportError(state.lastError);
    onStateChanged();
  });
  refresh();
  return {
    render,
    select,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      unsubscribe?.();
      for (const remove of removers.splice(0)) remove();
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingRailScroll, scrollRailTo } from './railScroll.js';

function fakeScroller({ scrollHeight = 1000, clientHeight = 400 } = {}) {
  const listeners = new Map();
  return {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    calls: [],
    scrollTo(options) {
      this.calls.push(options);
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    fire(type) {
      listeners.get(type)?.();
    },
    listening: (type) => listeners.has(type),
  };
}

test('a smooth rail scroll records where it is headed, clamped to the scroll range', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scroller = fakeScroller();
  assert.equal(scrollRailTo(scroller, 900), 600, 'clamped to 1000 - 400');
  assert.deepEqual(scroller.calls, [{ top: 600, behavior: 'smooth' }]);
  assert.equal(pendingRailScroll(scroller), 600);
  // A scrollend before arrival (a layout pass cancelled it) keeps the target.
  scroller.scrollTop = 120;
  scroller.fire('scrollend');
  assert.equal(pendingRailScroll(scroller), 600);
  // Arrival clears it, and the listener is released.
  scroller.scrollTop = 600;
  scroller.fire('scrollend');
  assert.equal(pendingRailScroll(scroller), undefined);
  assert.equal(scroller.listening('scrollend'), false);
});

test('a destination that never arrives is forgotten, so it cannot pin the rail', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scroller = fakeScroller();
  scrollRailTo(scroller, 300);
  t.mock.timers.tick(1499);
  assert.equal(pendingRailScroll(scroller), 300);
  t.mock.timers.tick(1);
  assert.equal(pendingRailScroll(scroller), undefined);
});

test('a newer scroll replaces the older destination; an instant one records none', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scroller = fakeScroller();
  scrollRailTo(scroller, 100);
  scrollRailTo(scroller, 250);
  assert.equal(pendingRailScroll(scroller), 250);
  scrollRailTo(scroller, -40, { smooth: false });
  assert.equal(pendingRailScroll(scroller), undefined);
  assert.deepEqual(scroller.calls.at(-1), { top: 0, behavior: 'auto' });
  // The replaced scroll's timer must not clear the newer destination.
  scrollRailTo(scroller, 200);
  t.mock.timers.tick(1500);
  assert.equal(pendingRailScroll(scroller), undefined);
});

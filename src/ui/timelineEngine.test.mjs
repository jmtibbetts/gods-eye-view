import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMELINE_SPAN_DAYS,
  clampOffset,
  dateForOffset,
  displayDateForOffset,
  isLiveOffset,
  latestPublishedDay,
  stepOffset,
  timelineLabel,
  timelinePositions,
} from './timelineEngine.js';

// 2026-09-17T12:00:00Z — so the latest fully-published UTC day is 2026-09-16.
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

test('the live frame is yesterday UTC, not today', () => {
  assert.equal(latestPublishedDay(NOW), '2026-09-16');
  assert.equal(dateForOffset(0, NOW), '2026-09-16');
});

test('offsets count backwards one day at a time', () => {
  assert.equal(dateForOffset(1, NOW), '2026-09-15');
  assert.equal(dateForOffset(5, NOW), '2026-09-11');
});

test('offsets clamp into range and survive junk', () => {
  assert.equal(clampOffset(-4), 0);
  assert.equal(clampOffset(999), TIMELINE_SPAN_DAYS - 1);
  assert.equal(clampOffset('3'), 3);
  assert.equal(clampOffset('nonsense'), 0);
  assert.equal(clampOffset(null), 0);
});

test('only offset zero is live', () => {
  assert.equal(isLiveOffset(0), true);
  assert.equal(isLiveOffset(1), false);
});

test('the live frame hands layers null rather than pinning a date', () => {
  // Pinning today's date would go stale the moment the UTC day rolls over.
  assert.equal(displayDateForOffset(0, NOW), null);
  assert.equal(displayDateForOffset(2, NOW), '2026-09-14');
});

test('labels say plainly whether this is live or history', () => {
  assert.equal(timelineLabel(0, NOW), 'LIVE · 2026-09-16');
  assert.equal(timelineLabel(1, NOW), '2026-09-15 · 1 day back');
  assert.equal(timelineLabel(3, NOW), '2026-09-13 · 3 days back');
});

test('positions run newest first and cover the span', () => {
  const positions = timelinePositions(3, NOW);
  assert.equal(positions.length, 3);
  assert.deepEqual(
    positions.map((p) => p.date),
    ['2026-09-16', '2026-09-15', '2026-09-14'],
  );
  assert.equal(positions[0].live, true);
  assert.equal(positions[1].live, false);
});

test('stepping stays inside the range', () => {
  assert.equal(stepOffset(0, 1), 1);
  assert.equal(stepOffset(0, -1), 0);
  assert.equal(stepOffset(TIMELINE_SPAN_DAYS - 1, 1), TIMELINE_SPAN_DAYS - 1);
  assert.equal(stepOffset(5, -2), 3);
  assert.equal(stepOffset(5, 0), 5);
});

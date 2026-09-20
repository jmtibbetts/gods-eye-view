import { pointInRing } from './naturalEarthRegions.js';

/**
 * Where a polygon's name should be written.
 *
 * THE PROBLEM. The bundled Natural Earth packs are outlines with no label
 * point in them — Natural Earth publishes `label_x`/`label_y`, and the
 * curation that produced these packs kept geometry only. So a layer that
 * wants to write "Norway" on the map has to decide where Norway is, and the
 * obvious answer is wrong: the centroid of a crescent is outside the
 * crescent. Norway's centroid is in Sweden. Chile's is in Argentina. A
 * country made of islands puts its centroid in open water.
 *
 * WHAT THIS DOES INSTEAD. It finds the pole of inaccessibility: the point
 * inside the shape that is furthest from any edge. That is the classic
 * cartographic answer — it is the middle of the widest part, which is the
 * part with room for the word — and it is inside the shape by construction.
 * The search is the usual one: cover the bounding box with cells, keep the
 * most promising cell (its distance to the boundary, plus how much better its
 * best corner could be), and quarter it until the remaining uncertainty is
 * below the precision asked for.
 *
 * Distances are in degrees, not metres. A label is placed to look right
 * rather than to measure anything, and the shape is drawn in degrees, so the
 * distortion toward the poles moves a label within its own country at worst.
 *
 * PURE module — no Cesium, node-testable.
 */

/** Shoelace area of a ring in square degrees; sign-free, for comparison only. */
export function ringArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    sum += (xj + xi) * (yj - yi);
  }
  return Math.abs(sum / 2);
}

/**
 * The biggest ring of a multi-polygon — the mainland.
 *
 * A country's name belongs on its mainland, not on whichever island the file
 * happens to list first, and taking the largest ring also sidesteps the
 * antimeridian: Natural Earth splits a country that crosses 180° into
 * separate rings either side, so the largest one is a contiguous piece with
 * no wrap in it.
 *
 * @param {Array<Array<[number,number]>>} polygons
 * @returns {Array<[number,number]>|null}
 */
export function largestRing(polygons) {
  if (!Array.isArray(polygons)) return null;
  let best = null;
  let bestArea = -1;
  for (const ring of polygons) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const area = ringArea(ring);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  return best;
}

/** Distance from a point to a segment, in degrees. */
function distanceToSegment(x, y, x1, y1, x2, y2) {
  let dx = x2 - x1;
  let dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x1 = x2;
      y1 = y2;
    } else if (t > 0) {
      x1 += dx * t;
      y1 += dy * t;
    }
  }
  dx = x - x1;
  dy = y - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Signed distance from a point to a ring: positive inside, negative outside.
 * @param {Array<[number,number]>} ring
 * @param {number} x Longitude.
 * @param {number} y Latitude.
 * @returns {number}
 */
export function signedDistanceToRing(ring, x, y) {
  let nearest = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    nearest = Math.min(nearest, distanceToSegment(x, y, xi, yi, xj, yj));
  }
  return (pointInRing(ring, y, x) ? 1 : -1) * nearest;
}

/** Bounding box of a ring as [west, south, east, north]. */
export function ringBounds(ring) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [x, y] of ring) {
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  }
  return [west, south, east, north];
}

/**
 * The point inside a multi-polygon furthest from its edge.
 *
 * @param {Array<Array<[number,number]>>} polygons Outer rings.
 * @param {{precision?: number}} [options] Stop once the answer cannot improve
 *   by more than this many degrees. The default is finer than any label needs
 *   and still costs well under a millisecond for a country.
 * @returns {{lon: number, lat: number, clearance: number}|null} `clearance` is
 *   the distance to the nearest edge in degrees — how much room the name has,
 *   which a caller can use to decide whether it fits at all.
 */
export function labelAnchor(polygons, { precision = 0.05 } = {}) {
  const ring = largestRing(polygons);
  if (!ring) return null;
  const [west, south, east, north] = ringBounds(ring);
  const width = east - west;
  const height = north - south;
  const cellSize = Math.min(width, height);
  if (!(cellSize > 0)) return { lon: west, lat: south, clearance: 0 };

  let best = null;
  const consider = (x, y, half) => {
    const distance = signedDistanceToRing(ring, x, y);
    const cell = {
      x,
      y,
      half,
      distance,
      ceiling: distance + half * Math.SQRT2,
    };
    if (!best || cell.distance > best.distance) best = cell;
    return cell;
  };

  // Seed with a grid over the box, plus the centroid of the vertices, which is
  // already the answer for anything convex.
  const queue = [];
  let half = cellSize / 2;
  for (let x = west + half; x < east; x += cellSize)
    for (let y = south + half; y < north; y += cellSize)
      queue.push(consider(x, y, half));
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of ring) {
    sumX += x;
    sumY += y;
  }
  consider(sumX / ring.length, sumY / ring.length, 0);

  // Refine the most promising cell until no cell could still beat the best.
  let guard = 0;
  while (queue.length && guard++ < 20_000) {
    queue.sort((a, b) => b.ceiling - a.ceiling);
    const cell = queue.shift();
    if (cell.ceiling - best.distance <= precision) break;
    half = cell.half / 2;
    if (half <= 0) continue;
    queue.push(
      consider(cell.x - half, cell.y - half, half),
      consider(cell.x + half, cell.y - half, half),
      consider(cell.x - half, cell.y + half, half),
      consider(cell.x + half, cell.y + half, half),
    );
  }

  return {
    lon: Number(best.x.toFixed(4)),
    lat: Number(best.y.toFixed(4)),
    clearance: Math.max(0, Number(best.distance.toFixed(4))),
  };
}

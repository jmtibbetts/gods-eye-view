#!/usr/bin/env node
/**
 * Verify every GIBS product in the imagery catalog still serves real pixels.
 *
 * This exists because of how GIBS fails. A retired layer id, a changed tile
 * matrix set, or a publication schedule that slipped by a day does NOT return
 * an error — it returns HTTP 200 with a solid black or fully transparent tile.
 * In the app that is indistinguishable from "the globe went blank", with
 * nothing in the console to explain it.
 *
 * So this fetches one real tile per product, decodes enough of it to count
 * distinct bytes, and fails when a product comes back featureless. Run it in
 * CI on a schedule rather than on every commit: it talks to NASA, and a
 * failure usually means their schedule moved, not that the code broke.
 *
 *   node scripts/check-imagery-catalog.mjs [--verbose]
 */

import { createHash } from 'node:crypto';
import {
  ALL_IMAGERY_PRODUCTS,
  gibsTileUrl,
  liveTimeFor,
} from '../src/layers/imageryOverlays/catalog.js';

const VERBOSE = process.argv.includes('--verbose');

/**
 * A tile that should contain data for this product, as {z, y, x}.
 *
 * Chosen per product family, because "is this blank?" is only meaningful over
 * ground the sensor actually sees: Himawari is parked over 140°E and shows
 * nothing over the Atlantic, sea ice is absent outside the poles, and land
 * temperature is empty over ocean. A global default tile would flag all three
 * as broken when they are working perfectly.
 */
/**
 * The zoom-3 column currently under the sun.
 *
 * A visible-band instrument returns black over the night side, so probing one
 * at a fixed longitude fails or passes depending on what time the check runs —
 * which is the worst kind of test. The sub-solar longitude moves 15 degrees an
 * hour from 180 at 00:00 UTC, so this follows it.
 */
function sunlitColumn(now = new Date()) {
  const hours = now.getUTCHours() + now.getUTCMinutes() / 60;
  let lon = 180 - hours * 15;
  while (lon < -180) lon += 360;
  while (lon > 180) lon -= 360;
  return Math.min(7, Math.max(0, Math.floor(((lon + 180) / 360) * 8)));
}

function probeTile(product) {
  const id = product.gibsId;
  // Follow the sun for anything that can only see by it.
  if (product.daylightOnly) return { z: 3, y: 3, x: sunlitColumn() };
  if (/Himawari/i.test(id)) return { z: 3, y: 3, x: 6 }; // west Pacific
  if (/Sea_Ice/i.test(id)) return { z: 3, y: 0, x: 3 }; // Arctic
  if (/Land_Surface_Temp/i.test(id)) return { z: 3, y: 2, x: 4 }; // N Africa
  if (/GOES-West/i.test(id)) return { z: 3, y: 3, x: 1 }; // east Pacific
  if (/Snow_Cover|NDSI/i.test(id)) return { z: 3, y: 1, x: 2 }; // Canada
  // The OPERA swath products cover strips rather than the globe, so their
  // probe tile has to be one that a pass actually crosses.
  if (/OPERA_L2/i.test(id)) return { z: 3, y: 2, x: 5 };
  if (/OPERA_L3/i.test(id)) return { z: 3, y: 4, x: 0 };
  return { z: 3, y: 3, x: 2 }; // N America / Atlantic
}

/**
 * Minimum byte size below which a tile is certainly featureless.
 *
 * `sparse` products get a much lower floor. They are classification rasters
 * and swath strips: a legitimate flood-extent tile is a handful of flat
 * colours over a partial footprint and compresses to well under a kilobyte.
 * Holding them to the photographic threshold would fail a product for looking
 * precisely like what it is supposed to look like.
 */
const MIN_BYTES = 2_000;
const MIN_BYTES_SPARSE = 700;

async function probe(product) {
  const time = liveTimeFor(product);
  const { z, y, x } = probeTile(product);
  const url = gibsTileUrl(product, time)
    .replace('{z}', z)
    .replace('{y}', y)
    .replace('{x}', x);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'gods-eye-view/imagery-catalog-check' },
    });
    if (!response.ok) {
      return { ok: false, product, time, url, why: `HTTP ${response.status}` };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
    const floor = product.sparse ? MIN_BYTES_SPARSE : MIN_BYTES;
    if (bytes.length < floor) {
      return {
        ok: false,
        product,
        time,
        url,
        why: `featureless tile (${bytes.length}B) — the product likely moved or has not published ${time}`,
      };
    }
    return { ok: true, product, time, url, size: bytes.length, digest };
  } catch (error) {
    return {
      ok: false,
      product,
      time,
      url,
      why: error?.message || 'fetch failed',
    };
  }
}

const results = [];
for (let i = 0; i < ALL_IMAGERY_PRODUCTS.length; i += 6) {
  results.push(
    ...(await Promise.all(ALL_IMAGERY_PRODUCTS.slice(i, i + 6).map(probe))),
  );
}

const failures = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok && VERBOSE)
    console.log(`  ok   ${r.product.key.padEnd(20)} ${r.time}  ${r.size}B`);
  if (!r.ok) {
    console.error(`  FAIL ${r.product.key.padEnd(20)} ${r.why}`);
    console.error(`       ${r.url}`);
  }
}

console.log(
  JSON.stringify({
    products: results.length,
    ok: results.length - failures.length,
    failed: failures.length,
  }),
);
if (failures.length) process.exit(1);

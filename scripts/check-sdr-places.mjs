#!/usr/bin/env node
/**
 * Check that each web SDR receiver is pinned where its name says it is.
 *
 * The receiver directory is built from receiverbook and the curated WebSDR
 * lists, and a receiver's coordinates are wherever its operator dropped the
 * marker. Usually that is their town. Sometimes it is not: "W4JCW | Camden,
 * South Carolina" sat sixty kilometres from Cape Canaveral, six hundred from
 * Camden, and the LAUNCH panel duly offered it as a receiver near the pad.
 *
 * So this pulls the place each name claims (see `sdrStatedPlace`), geocodes
 * it with Nominatim — one request a second, as their policy asks, cached on
 * disk so a re-run costs nothing — and reports every receiver whose pin is
 * more than 150 km from the place. With --write it marks those rows in
 * receivers.json (`placeStated`, `placeKm`) and clears the mark from any that
 * now agree, so the layer can say "position unverified" on the card and the
 * LAUNCH panel can leave them out of "near the pad".
 *
 *   node scripts/check-sdr-places.mjs [--write] [--limit N] [--verbose]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  sdrRegionWithoutDirection,
  sdrStatedPlace,
} from '../src/layers/sdr/records.js';

const ARGS = process.argv.slice(2);
const WRITE = ARGS.includes('--write');
const VERBOSE = ARGS.includes('--verbose');
const LIMIT = Number(ARGS[ARGS.indexOf('--limit') + 1]) || Infinity;

const SEED = path.join(
  process.cwd(),
  'src/data/local_data/sdr_receivers/receivers.json',
);
const CACHE = path.join(process.cwd(), '.gev-cache/sdr-place-geocode-v2.json');
const USER_AGENT =
  'gods-eye-view-sdr-place-audit/1.0 (+https://github.com/jmtibbetts/gods-eye-view)';
/** Farther than this and the pin is somewhere else. Towns are not that big. */
export const FAR_KM = 150;
/** A region-level hit (a state, a province) counts if the pin is inside it, with this much slack. */
const BBOX_MARGIN_DEG = 0.2;
const NOMINATIM_GAP_MS = 1100;
/**
 * Names that are a product's shipped default rather than a claim: a KiwiSDR
 * that was never renamed says it is in Tauranga, New Zealand, because that
 * is where KiwiSDR is made. The pin is the operator's; the name is not.
 */
export const PLACEHOLDER_PLACES = Object.freeze(['Tauranga, New Zealand']);

export function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One geocode, cached: the top few hits, each with its bounding box, or an
 * empty list when Nominatim has nothing for the text. Several hits because
 * a town name is rarely unique — there are two Grevens and three Moultons —
 * and the operator meant whichever one they are near.
 */
async function geocode(query, cache) {
  if (Object.prototype.hasOwnProperty.call(cache, query)) return cache[query];
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
  const hits = await response.json();
  cache[query] = (Array.isArray(hits) ? hits : [])
    .map((hit) => {
      const lat = Number(hit?.lat);
      const lon = Number(hit?.lon);
      const box = (hit?.boundingbox || []).map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return {
        lat,
        lon,
        name: hit.display_name || null,
        box: box.length === 4 && box.every(Number.isFinite) ? box : null,
      };
    })
    .filter(Boolean);
  await sleep(NOMINATIM_GAP_MS);
  return cache[query];
}

/** Whether a point lies inside a Nominatim [south, north, west, east] box, with slack. */
export function insideBox(lat, lon, box, margin = BBOX_MARGIN_DEG) {
  if (!box) return false;
  const [south, north, west, east] = box;
  return (
    lat >= south - margin &&
    lat <= north + margin &&
    lon >= west - margin &&
    lon <= east + margin
  );
}

/**
 * Audit one receiver against a geocoder that returns hits with boxes. A pin
 * agrees with its name when ANY hit is within FAR_KM of it or contains it —
 * a state-level claim ("Virginia, USA") is met anywhere in the state.
 * Exported for the unit test.
 * @returns {{status:'ok'|'far'|'placeholder'|'unplaced'|'unresolved', stated:string|null, km:number|null}}
 */
export async function auditReceiver(receiver, lookup) {
  const stated = sdrStatedPlace(receiver.name);
  if (!stated) return { status: 'unplaced', stated: null, km: null };
  const agree = async (query) => {
    const hits = await lookup(query);
    if (!Array.isArray(hits) || !hits.length) return null;
    let best = Infinity;
    let inside = false;
    for (const hit of hits) {
      best = Math.min(
        best,
        distanceKm(receiver.lat, receiver.lon, hit.lat, hit.lon),
      );
      if (insideBox(receiver.lat, receiver.lon, hit.box)) inside = true;
    }
    return { ok: inside || best <= FAR_KM, km: Math.round(best) };
  };
  let result = await agree(stated);
  // "W. Montana" is Montana; try the region alone before calling it far.
  if (!result?.ok) {
    const region = sdrRegionWithoutDirection(stated);
    if (region) {
      const again = await agree(region);
      if (again?.ok) result = again;
      else if (!result && again) result = again;
    }
  }
  if (!result) return { status: 'unresolved', stated, km: null };
  if (result.ok) return { status: 'ok', stated, km: result.km };
  if (PLACEHOLDER_PLACES.includes(stated))
    return { status: 'placeholder', stated, km: result.km };
  return { status: 'far', stated, km: result.km };
}

async function main() {
  const seed = JSON.parse(readFileSync(SEED, 'utf8'));
  const cache = loadCache();
  const counts = { ok: 0, far: 0, placeholder: 0, unplaced: 0, unresolved: 0 };
  const far = [];
  let checked = 0;
  for (const receiver of seed.receivers) {
    if (checked >= LIMIT) break;
    let result;
    try {
      result = await auditReceiver(receiver, (q) => geocode(q, cache));
    } catch (error) {
      console.error(`  ! ${receiver.id}: ${error.message}`);
      saveCache(cache);
      continue;
    }
    counts[result.status]++;
    if (result.status !== 'unplaced') checked++;
    if (VERBOSE && result.status !== 'unplaced')
      console.log(
        `  ${result.status.padEnd(10)} ${String(result.km ?? '').padStart(5)} km  ${receiver.name}`,
      );
    if (result.status === 'far') {
      far.push({ receiver, ...result });
      if (WRITE) {
        receiver.placeStated = result.stated;
        receiver.placeKm = result.km;
        delete receiver.placeDefault;
      }
    } else if (WRITE) {
      delete receiver.placeStated;
      delete receiver.placeKm;
      if (result.status === 'placeholder') receiver.placeDefault = true;
      else delete receiver.placeDefault;
    }
    if (checked % 25 === 0) saveCache(cache);
  }
  saveCache(cache);
  console.log(
    `checked ${checked} receivers with a stated place: ${counts.ok} agree, ${counts.far} far, ${counts.placeholder} carry a product's default name, ${counts.unresolved} unresolved; ${counts.unplaced} names claim no place`,
  );
  for (const f of far)
    console.log(
      `  ${String(f.km).padStart(5)} km  ${f.receiver.name}  (pin ${f.receiver.lat.toFixed(2)}, ${f.receiver.lon.toFixed(2)}; claims ${f.stated})`,
    );
  if (WRITE) {
    seed._meta = {
      ...seed._meta,
      placeAudit: {
        at: new Date().toISOString().slice(0, 10),
        checked,
        far: counts.far,
        farKm: FAR_KM,
      },
    };
    writeFileSync(SEED, JSON.stringify(seed), 'utf8');
    console.log(`wrote ${far.length} marks to ${path.relative(process.cwd(), SEED)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

/**
 * Lightning proxy — GOES Geostationary Lightning Mapper, Level-2 flashes.
 *
 * WHY THIS SOURCE. Real-time lightning is the one hazard feed in this project
 * with no obvious keyless option: the well-known networks are either paid or
 * licence-encumbered in ways that forbid redisplay. GLM is the exception. It
 * rides on the GOES satellites, publishes to NOAA's open-data buckets on S3
 * with no key, no registration and no account, under NOAA Open Data
 * Dissemination, and it lands a new file every TWENTY SECONDS.
 *
 * WHAT IT DOES NOT COVER. GOES is geostationary over the Americas: GOES-19 East
 * sees roughly the Atlantic to the Rockies, GOES-18 West the Pacific to the
 * Rockies. Together that is most of the Western Hemisphere and nothing else.
 * There is no Europe, Africa, Asia or Oceania coverage from this source at any
 * price, and the layer says so rather than letting an empty Europe read as a
 * quiet one.
 *
 * WHY THE PARSING HAPPENS HERE. The files are netCDF-4, which is HDF5, and S3
 * actually does send CORS headers — so a browser could fetch them directly. It
 * would be downloading 400 KB of HDF5 per twenty seconds and carrying a WASM
 * reader to open it. Parsed here, the same information is about 20 KB of JSON.
 * This is a size decision, not a CORS workaround.
 *
 * Route:
 *   GET /api/lightning/flashes → { flashes: [...], satellites: [...], window }
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedJsonEndpoint } from './cachedEndpoint.js';

/** East and West. Each is independent: one failing must not blank the other. */
const SATELLITES = Object.freeze([
  Object.freeze({ id: 'G19', bucket: 'noaa-goes19', name: 'GOES-19 East' }),
  Object.freeze({ id: 'G18', bucket: 'noaa-goes18', name: 'GOES-18 West' }),
]);

/**
 * How many 20-second files to read per satellite.
 *
 * Three is a minute of flashes — enough that the map is never empty between
 * refreshes, and little enough that a refresh moves about 1.2 MB server-side
 * rather than tens of megabytes.
 */
const FILES_PER_SATELLITE = 3;

/** Matches the refresh cadence; the upstream cannot be fresher than 20 s. */
const TTL_MS = 30_000;
const TIMEOUT_MS = 25_000;

/** UTC day-of-year, which is how the bucket is laid out. */
function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86_400_000);
}

function hourPrefix(date) {
  const yyyy = date.getUTCFullYear();
  const ddd = String(dayOfYear(date)).padStart(3, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  return `GLM-L2-LCFA/${yyyy}/${ddd}/${hh}/`;
}

/** Keys in one hour prefix, oldest first. */
async function listHour(bucket, prefix, signal) {
  const url = `https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=400`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`S3 list HTTP ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

/**
 * The most recent keys for one satellite.
 *
 * Looks at the previous hour as well as the current one, because for the first
 * minute of every hour the current prefix holds fewer files than we want — and
 * a lightning map that goes sparse on the hour, every hour, would look like
 * the weather rather than like a bug.
 */
async function recentKeys(bucket, count, now, signal) {
  const current = await listHour(bucket, hourPrefix(now), signal);
  if (current.length >= count) return current.slice(-count);
  const previous = await listHour(
    bucket,
    hourPrefix(new Date(now.getTime() - 3_600_000)),
    signal,
  );
  return [...previous, ...current].slice(-count);
}

/**
 * Lazily started, then reused: the WASM module is a few megabytes.
 *
 * The node build reads REAL paths rather than an in-memory filesystem, so the
 * bytes are staged through the OS temp directory. Writing to a made-up path at
 * the filesystem root fails with "Operation not permitted", which is the
 * filesystem being right rather than the library being broken.
 */
let h5Ready = null;
async function h5() {
  if (!h5Ready) {
    h5Ready = (async () => {
      const mod = await import('h5wasm/node');
      const api = mod.default ?? mod;
      await api.ready;
      const File = api.File ?? mod.File;
      if (typeof File !== 'function') throw new Error('h5wasm exposed no File');
      return { File };
    })().catch((error) => {
      // Do not cache the failure forever; a later request may succeed.
      h5Ready = null;
      throw error;
    });
  }
  return h5Ready;
}

/**
 * Flashes from one GLM file.
 *
 * `flash_quality_flag` 0 means a good flash. Anything else is kept out: GLM's
 * own processing is saying it does not stand behind the location, and a
 * lightning strike drawn in the wrong place is not a lesser version of a right
 * one.
 */
async function readFlashes(h5wasm, bytes, satellite, path) {
  const { File } = h5wasm;
  await writeFile(path, Buffer.from(bytes));
  let file = null;
  try {
    file = new File(path, 'r');
    const lat = file.get('flash_lat')?.to_array?.() ?? [];
    const lon = file.get('flash_lon')?.to_array?.() ?? [];
    const energy = file.get('flash_energy')?.to_array?.() ?? [];
    const quality = file.get('flash_quality_flag')?.to_array?.() ?? [];
    const out = [];
    for (let i = 0; i < lat.length; i += 1) {
      if (quality[i] !== 0) continue;
      const la = Number(lat[i]);
      const lo = Number(lon[i]);
      if (!Number.isFinite(la) || Math.abs(la) > 90) continue;
      if (!Number.isFinite(lo) || Math.abs(lo) > 180) continue;
      out.push({
        lat: Math.round(la * 1000) / 1000,
        lon: Math.round(lo * 1000) / 1000,
        energy: Number(energy[i]) || 0,
        sat: satellite.id,
      });
    }
    return out;
  } finally {
    try {
      file?.close();
    } catch {
      /* closing a half-opened file must not mask the read error */
    }
  }
}

/** Every recent flash from one satellite, or null if it could not be read. */
async function loadSatellite(satellite, now, signal) {
  let scratch = null;
  try {
    const h5wasm = await h5();
    const keys = await recentKeys(
      satellite.bucket,
      FILES_PER_SATELLITE,
      now,
      signal,
    );
    scratch = await mkdtemp(join(tmpdir(), `glm-${satellite.id}-`));
    const flashes = [];
    let newest = null;
    for (const [index, key] of keys.entries()) {
      const response = await fetch(
        `https://${satellite.bucket}.s3.amazonaws.com/${key}`,
        { signal },
      );
      if (!response.ok) continue;
      const bytes = await response.arrayBuffer();
      flashes.push(
        ...(await readFlashes(
          h5wasm,
          bytes,
          satellite,
          join(scratch, `${index}.nc`),
        )),
      );
      newest = key;
    }
    return { satellite, flashes, newest };
  } catch (error) {
    console.warn(`[Lightning] ${satellite.name} failed: ${error?.message}`);
    return null;
  } finally {
    if (scratch)
      await rm(scratch, { recursive: true, force: true }).catch(() => {
        /* a leftover temp directory must not fail the request */
      });
  }
}

async function loadAll() {
  const now = new Date();
  const results = await Promise.all(
    SATELLITES.map((satellite) => loadSatellite(satellite, now, undefined)),
  );
  const ok = results.filter(Boolean);
  // One satellite failing must not blank the other hemisphere's half.
  if (!ok.length) throw new Error('no GLM data from either satellite');
  return {
    at: now.toISOString(),
    windowSeconds: FILES_PER_SATELLITE * 20,
    satellites: ok.map((r) => ({
      id: r.satellite.id,
      name: r.satellite.name,
      flashes: r.flashes.length,
      newest: r.newest,
    })),
    // Which satellites are MISSING matters as much as which are present: a
    // reader needs to know an empty Pacific means "not looked at" rather than
    // "no lightning".
    missing: SATELLITES.filter(
      (s) => !ok.some((r) => r.satellite.id === s.id),
    ).map((s) => s.id),
    flashes: ok.flatMap((r) => r.flashes),
  };
}

export function lightningProxy() {
  const flashes = cachedJsonEndpoint({
    load: loadAll,
    ttlMs: TTL_MS,
    label: 'Lightning GLM',
    timeoutMs: TIMEOUT_MS,
  });

  function installMiddleware(server) {
    server.middlewares.use('/api/lightning/flashes', flashes);
  }

  return {
    name: 'gev-lightning-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

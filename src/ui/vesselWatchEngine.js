/**
 * Vessel enrichment engine (pure): two reads over the live AIS feed that the
 * raw feed does not give you.
 *
 * Sanctions matching is done on MMSI alone, never on name. Vessel names repeat
 * across the world fleet, so a name match would confidently mislabel innocent
 * ships; an MMSI is an exact identifier, and a vessel the list does not key by
 * MMSI is simply not matched. That asymmetry matters and is stated in the UI:
 * absence from the table is not evidence a vessel is unlisted.
 *
 * Dark-ship detection is likewise deliberately conservative. AIS coverage is
 * patchy — a vessel dropping out of one poll usually means nobody heard it,
 * not that it switched off — so a vessel is only called dark after it has been
 * seen repeatedly and then stayed missing for a sustained period.
 *
 * No Cesium, no DOM, no network.
 */

/** A vessel must be missing at least this long before it is called dark. */
export const DARK_AFTER_MS = 15 * 60 * 1000;
/** And must have been seen at least this many times, so blips do not count. */
export const MIN_SIGHTINGS = 3;
/** Tracks older than this are forgotten entirely. */
export const TRACK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Normalise the bundled OFAC vessel table into a Map keyed by MMSI.
 * @param {any} payload Parsed vessels.json.
 * @returns {Map<string, object>}
 */
export function normalizeSanctionedVessels(payload) {
  const out = new Map();
  const table = payload?.vessels;
  if (!table || typeof table !== 'object') return out;
  for (const [mmsi, entry] of Object.entries(table)) {
    const key = String(mmsi).trim();
    if (!/^[0-9]{9}$/.test(key)) continue;
    out.set(key, {
      mmsi: key,
      name: String(entry?.name ?? '').trim(),
      program: String(entry?.program ?? '').trim(),
      flag: String(entry?.flag ?? '').trim(),
      type: String(entry?.type ?? '').trim(),
      imo: String(entry?.imo ?? '').trim(),
    });
  }
  return out;
}

/**
 * Fold this scan's vessel records into the running track table.
 * @param {Map<string, object>} tracks Mutated in place and returned.
 * @param {object[]} records Vessel analyst records.
 * @param {number} now
 * @returns {Map<string, object>}
 */
export function updateVesselTracks(tracks, records, now) {
  for (const record of records || []) {
    const mmsi = String(record?.mmsi ?? '').trim();
    if (!mmsi) continue;
    const lat = Number(record.lat);
    const lon = Number(record.lon);
    const existing = tracks.get(mmsi);
    const track = existing || {
      mmsi,
      name: '',
      lat: null,
      lon: null,
      firstSeen: now,
      sightings: 0,
      reported: false,
    };
    track.name = String(record.name ?? track.name ?? '').trim();
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      track.lat = lat;
      track.lon = lon;
    }
    track.lastSeen = now;
    track.sightings += 1;
    // Seen again, so a previous dark report is spent and may re-arm.
    track.reported = false;
    tracks.set(mmsi, track);
  }
  return tracks;
}

/**
 * Vessels that were being tracked and have now stayed silent long enough to
 * count as having gone dark.
 * @param {Map<string, object>} tracks
 * @param {number} now
 * @param {{darkAfterMs?:number, minSightings?:number}} [options]
 * @returns {object[]} Newest gap first.
 */
export function findDarkVessels(
  tracks,
  now,
  { darkAfterMs = DARK_AFTER_MS, minSightings = MIN_SIGHTINGS } = {},
) {
  const dark = [];
  for (const track of tracks.values()) {
    if (track.sightings < minSightings) continue;
    const silentMs = now - track.lastSeen;
    if (silentMs < darkAfterMs) continue;
    if (!Number.isFinite(track.lat) || !Number.isFinite(track.lon)) continue;
    dark.push({ ...track, silentMs });
  }
  dark.sort((a, b) => a.silentMs - b.silentMs);
  return dark;
}

/**
 * Live vessels whose MMSI appears on the sanctions table.
 * @param {object[]} records
 * @param {Map<string, object>} table
 * @returns {Array<{record:object, listing:object}>}
 */
export function matchSanctionedVessels(records, table) {
  const hits = [];
  if (!table?.size) return hits;
  const seen = new Set();
  for (const record of records || []) {
    const mmsi = String(record?.mmsi ?? '').trim();
    if (!mmsi || seen.has(mmsi)) continue;
    const listing = table.get(mmsi);
    if (!listing) continue;
    seen.add(mmsi);
    hits.push({ record, listing });
  }
  return hits;
}

/**
 * Forget tracks nothing has heard from in a long time, so the table cannot
 * grow without bound across a long session.
 * @param {Map<string, object>} tracks Mutated in place.
 * @param {number} now
 * @param {number} [ttlMs]
 * @returns {number} How many were dropped.
 */
export function pruneVesselTracks(tracks, now, ttlMs = TRACK_TTL_MS) {
  let dropped = 0;
  for (const [mmsi, track] of tracks) {
    if (now - track.lastSeen > ttlMs) {
      tracks.delete(mmsi);
      dropped++;
    }
  }
  return dropped;
}

/** How long a vessel has been silent, in words. */
export function silenceText(silentMs) {
  const minutes = Math.round(silentMs / 60000);
  if (minutes < 60) return `silent ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `silent ${hours}h ${rest}m` : `silent ${hours}h`;
}

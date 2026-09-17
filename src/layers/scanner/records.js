import { OPENMHZ_MEDIA_HOST } from './policy.js';

const ID_RE = /^[a-z0-9_-]{1,40}$/i;

const text = (value, max = 120) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const finite = (value) => (Number.isFinite(value) ? value : null);

/**
 * Validate the bundled seed catalog. Rejects the whole file on any malformed
 * row so a bad build can never half-paint the globe.
 * @param {unknown} payload Parsed systems.json.
 * @returns {Array<object>|null}
 */
export function normalizeScannerSeed(payload) {
  const rows = payload?.systems;
  if (!Array.isArray(rows)) return null;
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') return null;
    const id = String(row.id ?? '');
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (
      !ID_RE.test(id) ||
      seen.has(id) ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180
    )
      return null;
    seen.add(id);
    out.push({
      id,
      name: text(row.name, 80) || id,
      type: text(row.type, 20) || 'unknown',
      city: text(row.city, 60) || null,
      county: text(row.county, 60) || null,
      state: text(row.state, 40) || null,
      country: text(row.country, 40) || 'USA',
      lat,
      lon,
      precision: text(row.precision, 10) || 'none',
      callAvg: Math.max(0, finite(Number(row.callAvg)) ?? 0),
      desc: text(row.desc, 120) || null,
      active: true,
      lastActive: null,
      clientCount: 0,
    });
  }
  return out;
}

/**
 * Validate the live `/systems` envelope. Only activity fields are trusted;
 * positions always come from the seed.
 * @param {unknown} payload Parsed `/systems` JSON.
 * @returns {Map<string, {active:boolean,lastActive:number|null,callAvg:number,clientCount:number,name:string|null}>|null}
 */
export function normalizeScannerSystems(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.systems;
  if (!Array.isArray(rows)) return null;
  const out = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.shortName ?? '');
    if (!ID_RE.test(id)) continue;
    const lastActive = Date.parse(row.lastActive ?? '');
    out.set(id, {
      active: row.active !== false,
      lastActive: Number.isFinite(lastActive) ? lastActive : null,
      callAvg: Math.max(0, finite(Number(row.callAvg)) ?? 0),
      clientCount: Math.max(
        0,
        Math.floor(finite(Number(row.clientCount)) ?? 0),
      ),
      name: text(row.name, 80) || null,
      city: text(row.city, 60) || null,
      state: text(row.state, 40) || null,
      type: text(row.systemType, 20) || null,
      desc: text(row.description, 120) || null,
    });
  }
  return out;
}

/**
 * Validate one call list. Rows with a bad audio host or shape are dropped
 * individually (the feed is append-only, so partial acceptance is safe).
 * @param {unknown} payload Parsed `/calls` or `/calls/newer` JSON.
 * @returns {Array<{id:string,time:number,talkgroup:number,len:number,freq:number|null,emergency:boolean,units:string[],url:string}>|null}
 */
export function normalizeScannerCalls(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.calls;
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const time = Date.parse(row.time ?? '');
    const talkgroup = Number(row.talkgroupNum);
    const url = scannerAudioUrl(row.url);
    if (!Number.isFinite(time) || !Number.isFinite(talkgroup) || !url) continue;
    const units = Array.isArray(row.srcList)
      ? row.srcList
          .map((s) => text(s?.tag || s?.src, 24))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    out.push({
      id: text(row._id, 40) || `${talkgroup}-${time}`,
      time,
      talkgroup,
      len: Math.max(0, finite(Number(row.len)) ?? 0),
      freq: finite(Number(row.freq)),
      emergency: row.emergency === true,
      units,
      url,
    });
  }
  return out;
}

/**
 * Only https audio on OpenMHz's media host is ever played.
 * @param {unknown} value Candidate URL.
 * @returns {string|null}
 */
export function scannerAudioUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' || url.hostname !== OPENMHZ_MEDIA_HOST)
      return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (!/\.(m4a|mp3|wav)$/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Talkgroup number → { alpha, description } from `/talkgroups`.
 * @param {unknown} payload
 * @returns {Map<number, {alpha:string, description:string}>}
 */
export function normalizeScannerTalkgroups(payload) {
  const out = new Map();
  const table = payload?.talkgroups;
  if (!table || typeof table !== 'object') return out;
  for (const value of Object.values(table)) {
    const num = Number(value?.num);
    if (!Number.isFinite(num)) continue;
    out.set(num, {
      alpha: text(value?.alpha, 24),
      description: text(value?.description, 48),
    });
  }
  return out;
}

/**
 * Talkgroup number → group name (Fire / EMS / Police …) from `/groups`.
 * @param {unknown} payload
 * @returns {Map<number, string>}
 */
export function normalizeScannerGroups(payload) {
  const out = new Map();
  if (!Array.isArray(payload)) return out;
  for (const group of payload) {
    const name = text(group?.groupName, 24);
    if (!name || !Array.isArray(group?.talkgroups)) continue;
    for (const tg of group.talkgroups) {
      const num = Number(tg);
      if (Number.isFinite(num) && !out.has(num)) out.set(num, name);
    }
  }
  return out;
}

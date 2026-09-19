import {
  ALERT_MAX_AGE_MS,
  AURORA_MIN_PROBABILITY,
  auroraBand,
} from './policy.js';

/**
 * Parse OVATION's latest grid: one probability per whole degree of
 * longitude (0–359, east) and latitude (−90–90). Anything that is not that
 * shape is refused whole — a half-parsed oval would draw a lie.
 * @param {object} payload
 * @returns {{observedAt:string|null, forecastAt:string|null, cells:Array<{lon:number,lat:number,p:number}>, max:number}|null}
 */
export function parseAurora(payload) {
  const rows = payload?.coordinates;
  if (!Array.isArray(rows) || rows.length < 1000) return null;
  const cells = [];
  let max = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) return null;
    const [lon, lat, p] = row.map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(p))
      return null;
    if (p > max) max = p;
    if (p < AURORA_MIN_PROBABILITY) continue;
    // Whole-degree cells at the poles collapse; keep them off the pole itself.
    if (Math.abs(lat) >= 90) continue;
    cells.push({ lon: lon > 180 ? lon - 360 : lon, lat, p });
  }
  return {
    observedAt: isoOrNull(payload['Observation Time']),
    forecastAt: isoOrNull(payload['Forecast Time']),
    cells,
    max,
  };
}

/**
 * SWPC stamps are UTC, and some come without a zone designator ("2026-09-19
 * T18:00:00"); those would otherwise parse as local time on the reader's
 * machine and shift by their offset.
 */
function isoOrNull(value) {
  const text = String(value ?? '').trim();
  const stamped = /[zZ]$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`;
  const t = Date.parse(stamped);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The newest three-hourly Kp, and the run of the last day. */
export function parseKp(payload) {
  if (!Array.isArray(payload)) return null;
  const rows = payload
    .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
    .map((r) => ({ at: isoOrNull(r.time_tag), kp: Number(r.Kp) }))
    .filter((r) => r.at && Number.isFinite(r.kp));
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  return {
    kp: latest.kp,
    at: latest.at,
    last24h: rows.slice(-8).map((r) => r.kp),
  };
}

/** SWPC's now-cast of the three scales, and the next three days' outlook. */
export function parseScales(payload) {
  const now = payload?.['0'];
  if (!now || typeof now !== 'object') return null;
  const scale = (entry) => ({
    level: Number.parseInt(entry?.Scale ?? '0', 10) || 0,
    text: entry?.Text || 'none',
  });
  const read = (day) => ({
    date: day?.DateStamp || null,
    R: scale(day?.R),
    S: scale(day?.S),
    G: scale(day?.G),
  });
  const outlook = ['1', '2', '3']
    .map((k) => payload[k])
    .filter(Boolean)
    .map(read);
  return { now: { ...read(now), time: now.TimeStamp || null }, outlook };
}

/**
 * Alerts, warnings and watches from the last day, newest first, one per
 * product code — a re-issued warning replaces the earlier copy.
 */
export function parseAlerts(payload, nowMs = Date.now()) {
  if (!Array.isArray(payload)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const at = Date.parse(
      String(raw.issue_datetime || '').replace(' ', 'T') + 'Z',
    );
    if (!Number.isFinite(at) || nowMs - at > ALERT_MAX_AGE_MS) continue;
    const code = String(raw.product_id || '').trim();
    if (!code || seen.has(code)) continue;
    const message = String(raw.message || '');
    const headline =
      message
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) =>
          /^(ALERT|WARNING|WATCH|SUMMARY|EXTENDED WARNING|CANCEL)/i.test(l),
        ) ||
      message
        .split(/\r?\n/)
        .find((l) => l.trim())
        ?.trim() ||
      code;
    seen.add(code);
    out.push({ code, at: new Date(at).toISOString(), headline, message });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Group drawn cells by ramp band, for one primitive per colour. */
export function bandCells(cells) {
  const groups = new Map();
  for (const cell of cells) {
    const band = auroraBand(cell.p);
    if (!band) continue;
    if (!groups.has(band.min)) groups.set(band.min, { band, cells: [] });
    groups.get(band.min).cells.push(cell);
  }
  return [...groups.values()];
}

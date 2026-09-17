import { ALERT_RANK, COLOR_RANK, alertSummary } from './policy.js';

const text = (value, max = 200) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Normalise the bundled vnum lookup into a Map of vnum → {lat, lon}.
 * @param {any} payload Parsed volcanoes.json.
 * @returns {Map<string, {lat:number, lon:number, elev:number|null}>}
 */
export function normalizeVolcanoCoordinates(payload) {
  const out = new Map();
  const table = payload?.volcanoes;
  if (!table || typeof table !== 'object') return out;
  for (const [vnum, entry] of Object.entries(table)) {
    const lat = Number(entry?.lat);
    const lon = Number(entry?.lon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    out.set(String(vnum), {
      lat,
      lon,
      elev: Number.isFinite(Number(entry?.elev)) ? Number(entry.elev) : null,
    });
  }
  return out;
}

/**
 * Join the live USGS elevated-volcano notices to bundled coordinates.
 *
 * A notice whose vnum is not in the lookup is counted but not drawn — better
 * to say "3 of 4 placed" than to invent a position for the fourth.
 *
 * @param {any} payload Parsed USGS getElevatedVolcanoes response.
 * @param {Map<string, {lat:number, lon:number, elev:number|null}>} coordinates
 * @returns {{volcanoes: object[], total: number, unplaced: string[]}|null}
 */
export function normalizeVolcanoAlerts(payload, coordinates) {
  if (!Array.isArray(payload)) return null;
  const volcanoes = [];
  const unplaced = [];
  const seen = new Set();
  for (const notice of payload) {
    const vnum = text(notice?.vnum, 16);
    if (!vnum || seen.has(vnum)) continue;
    seen.add(vnum);
    // Name and level are always the live notice's, never the lookup's: the
    // bundle can resolve a vnum to a named vent rather than the volcano.
    const name = text(notice?.volcano_name, 80) || `Volcano ${vnum}`;
    const point = coordinates?.get?.(vnum);
    if (!point) {
      unplaced.push(name);
      continue;
    }
    const colorCode =
      text(notice?.color_code, 16).toUpperCase() || 'UNASSIGNED';
    const alertLevel = text(notice?.alert_level, 16).toUpperCase() || 'NORMAL';
    volcanoes.push({
      id: vnum,
      vnum,
      name,
      colorCode,
      alertLevel,
      summary: alertSummary(colorCode, alertLevel),
      observatory: text(notice?.obs_fullname, 80),
      observatoryAbbr: text(notice?.obs_abbr, 12).toUpperCase(),
      sentUtc: text(notice?.sent_utc, 32),
      noticeUrl: text(notice?.notice_url, 400),
      colorRank: COLOR_RANK[colorCode] ?? 0,
      alertRank: ALERT_RANK[alertLevel] ?? 0,
      lat: point.lat,
      lon: point.lon,
      elevationM: point.elev,
    });
  }
  // Least severe first, so the worst volcano is added last and draws on top.
  volcanoes.sort(
    (a, b) => a.colorRank - b.colorRank || a.alertRank - b.alertRank,
  );
  return { volcanoes, total: payload.length, unplaced };
}

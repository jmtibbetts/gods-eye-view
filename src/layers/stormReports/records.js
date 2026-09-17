import { KIND_RANK, REPORT_KINDS, magnitudeText } from './policy.js';

const text = (value, max = 400) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Split one SPC CSV row into at most 8 fields. Comments are last and may
 * themselves contain commas, so everything past the 7th separator is rejoined
 * rather than dropped. SPC does not quote fields.
 * @param {string} line
 * @returns {string[]}
 */
export function splitReportRow(line) {
  const parts = String(line ?? '').split(',');
  if (parts.length <= 8) return parts;
  return [...parts.slice(0, 7), parts.slice(7).join(',')];
}

/**
 * Read a coordinate cell. An empty cell must not become 0 — `Number('')` is a
 * finite zero, which would silently plant the report in the Gulf of Guinea.
 * @param {string} value
 * @returns {number} The parsed degrees, or NaN when the cell is blank.
 */
function coordinate(value) {
  const raw = String(value ?? '').trim();
  return raw ? Number(raw) : Number.NaN;
}

/** A header row opens a section and names its kind via the second column. */
function sectionKind(fields) {
  if (fields[0] !== 'Time') return null;
  return REPORT_KINDS[fields[1]] || null;
}

/**
 * Parse one day's SPC reports CSV into records.
 *
 * @param {string} csv Raw file body.
 * @param {string} [day] Label carried onto each record ('today'/'yesterday').
 * @returns {object[]}
 */
export function parseStormReports(csv, day = 'today') {
  if (typeof csv !== 'string' || !csv.trim()) return [];
  const out = [];
  let kind = null;
  let index = 0;
  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = splitReportRow(line);
    const header = sectionKind(fields);
    if (header) {
      kind = header;
      continue;
    }
    if (!kind || fields.length < 7) continue;
    const lat = coordinate(fields[5]);
    const lon = coordinate(fields[6]);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    const time = text(fields[0], 8);
    const magnitude = text(fields[1], 16);
    const location = text(fields[2], 120);
    const county = text(fields[3], 80);
    const state = text(fields[4], 8);
    out.push({
      id: `${day}:${kind}:${index++}:${lat.toFixed(2)},${lon.toFixed(2)}`,
      kind,
      day,
      time,
      magnitude,
      magnitudeText: magnitudeText(kind, magnitude),
      location,
      county,
      state,
      comments: text(fields[7], 600),
      lat,
      lon,
    });
  }
  return out;
}

/**
 * Merge per-day parses into one drawable set, de-duplicated and ordered so the
 * rarer, more significant kinds are added last (and so draw on top).
 * @param {Array<{day: string, csv: string}>} days
 * @returns {{reports: object[], byKind: Record<string, number>}}
 */
export function normalizeStormReports(days) {
  const reports = [];
  const seen = new Set();
  for (const { day, csv } of days || []) {
    for (const report of parseStormReports(csv, day)) {
      // Same spotter report can repeat across the rolling files.
      const key = `${report.kind}|${report.time}|${report.lat},${report.lon}|${report.location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reports.push(report);
    }
  }
  reports.sort((a, b) => (KIND_RANK[a.kind] || 0) - (KIND_RANK[b.kind] || 0));
  const byKind = {};
  for (const report of reports)
    byKind[report.kind] = (byKind[report.kind] || 0) + 1;
  return { reports, byKind };
}

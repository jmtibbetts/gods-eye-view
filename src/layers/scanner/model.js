import {
  SCANNER_COLORS,
  SCANNER_DISCIPLINES,
  SCANNER_HISTORY_LIMIT,
  SCANNER_OVERLAY_COHORT_LIMIT,
} from './policy.js';

/** Activity band for one system, from its rolling calls-per-minute. */
export function scannerActivityBand(system) {
  if (system?.active === false) return 'idle';
  const rate = Number(system?.callAvg) || 0;
  if (rate >= 10) return 'hot';
  if (rate >= 3) return 'busy';
  if (rate > 0) return 'quiet';
  return 'idle';
}

export function scannerColor(system) {
  return SCANNER_COLORS[scannerActivityBand(system)];
}

/** Dot size: busier systems read larger so the eye lands on live traffic. */
export function scannerPixelSize(system) {
  switch (scannerActivityBand(system)) {
    case 'hot':
      return 12;
    case 'busy':
      return 10;
    case 'quiet':
      return 8;
    default:
      return 6;
  }
}

/** Where-string for a system: "Chicago, IL" / "King County, WA" / "Vancouver, Canada". */
export function scannerPlace(system) {
  const parts = [];
  if (system.city) parts.push(system.city);
  else if (system.county)
    parts.push(
      /county/i.test(system.county) ? system.county : `${system.county} County`,
    );
  if (system.state) parts.push(system.state);
  if (!parts.length && system.country) parts.push(system.country);
  else if (system.country && system.country !== 'USA')
    parts.push(system.country);
  return parts.join(', ');
}

/**
 * Classify a talkgroup as fire / ems / police / other from its labels.
 * @param {{alpha?:string, description?:string, group?:string}} label
 */
export function scannerDiscipline(label) {
  const hay = ` ${[label?.group, label?.description, label?.alpha]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()} `;
  for (const [discipline, keys] of SCANNER_DISCIPLINES) {
    if (keys.some((k) => hay.includes(k))) return discipline;
  }
  return 'other';
}

const DISCIPLINE_GLYPH = Object.freeze({
  fire: '🔥',
  ems: '🚑',
  police: '🚔',
  other: '📻',
});

export function scannerCallLine(
  call,
  labels,
  { now = Date.now(), playing = false } = {},
) {
  const label = labels?.get?.(call.talkgroup) || null;
  const name = label?.description || label?.alpha || `TG ${call.talkgroup}`;
  const glyph = DISCIPLINE_GLYPH[scannerDiscipline(label)];
  const age = Math.max(0, Math.round((now - call.time) / 1000));
  const ageText = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
  const units = call.units.length
    ? ` · ${call.units.slice(0, 2).join(' ')}`
    : '';
  const flag = call.emergency ? ' ‼' : '';
  return `${playing ? '▶' : glyph} ${name}${flag} · ${Math.round(call.len)}s · ${ageText}${units}`;
}

/** Ambient name label for one system marker. */
export function createScannerOverlayEntry({ id, position, system }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: system.name,
    accent: scannerColor(system),
    priority: Math.round((Number(system.callAvg) || 0) * 1000),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the busiest systems' labels; dots stay for the rest. */
export function selectScannerOverlayCohort(
  entries,
  limit = SCANNER_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(SCANNER_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * The selected-system card: place, live status, and the last few
 * transmissions with the one playing marked ▶.
 */
export function createScannerSelectedOverlayEntry({
  id,
  position,
  system,
  calls = [],
  labels = null,
  player = null,
  status = null,
  now = Date.now(),
}) {
  const details = [];
  const place = scannerPlace(system);
  const kind = system.type && system.type !== 'unknown' ? system.type : null;
  details.push([place, kind].filter(Boolean).join(' · ') || 'OpenMHz system');
  const rate = Number(system.callAvg) || 0;
  const live =
    player?.state === 'playing' || player?.state === 'waiting'
      ? 'LIVE'
      : player?.paused
        ? 'PAUSED'
        : status || 'MONITORING';
  details.push(
    `${live} · ${rate.toFixed(1)} calls/min · ${player?.queued ?? 0} queued${
      player?.dropped ? ` · ${player.dropped} skipped` : ''
    }`,
  );
  const recent = calls.slice(0, SCANNER_HISTORY_LIMIT);
  for (const call of recent) {
    details.push(
      scannerCallLine(call, labels, {
        now,
        playing: player?.current?.id === call.id,
      }),
    );
  }
  if (!recent.length)
    details.push(
      status === 'error' ? 'feed unavailable' : 'waiting for traffic…',
    );
  details.push('click again: pause · esc: stop');
  return {
    id: String(id),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: system.name,
    details,
    accent: SCANNER_COLORS.selected,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/** JSON-safe record for the analyst query engine. */
export function mapScannerAnalystRecord(system, index = 0) {
  return {
    id: String(system?.id || `SCAN-${String(index).padStart(4, '0')}`),
    name: system?.name ?? null,
    place: scannerPlace(system || {}) || null,
    type: system?.type ?? null,
    lat: Number.isFinite(system?.lat) ? system.lat : null,
    lon: Number.isFinite(system?.lon) ? system.lon : null,
    callsPerMinute: Number.isFinite(system?.callAvg) ? system.callAvg : null,
    active: system?.active !== false,
    listeners: Number.isFinite(system?.clientCount) ? system.clientCount : null,
  };
}

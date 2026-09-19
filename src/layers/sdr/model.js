import {
  SDR_COLORS,
  SDR_DEFAULT_MODE,
  SDR_MODES,
  SDR_OVERLAY_COHORT_LIMIT,
  SDR_TYPE_LABELS,
} from './policy.js';

export function sdrColor(receiver) {
  return SDR_COLORS[receiver?.type] || SDR_COLORS.sdr;
}

export function sdrTypeLabel(receiver) {
  return SDR_TYPE_LABELS[receiver?.type] || SDR_TYPE_LABELS.sdr;
}

/** "0–30 MHz" / "144–146 MHz" from a [lowHz, highHz] pair. */
export function sdrBandText(bands) {
  if (!Array.isArray(bands)) return null;
  const [lo, hi] = bands;
  const mhz = (hz) => {
    const v = hz / 1e6;
    const text =
      v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  };
  return `${mhz(lo)}–${mhz(hi)} MHz`;
}

/** True when a frequency (Hz) falls inside the receiver's advertised range. */
export function sdrCoversFrequency(receiver, hz) {
  if (!Number.isFinite(hz)) return null;
  if (Array.isArray(receiver?.ranges) && receiver.ranges.length)
    return receiver.ranges.some((r) => hz >= r[0] && hz <= r[1]);
  if (!Array.isArray(receiver?.bands)) return null;
  return hz >= receiver.bands[0] && hz <= receiver.bands[1];
}

function normalizeMode(mode) {
  const m = String(mode || SDR_DEFAULT_MODE).toLowerCase();
  if (m === 'fm') return 'nbfm';
  return SDR_MODES.includes(m) ? m : SDR_DEFAULT_MODE;
}

/**
 * Build the receiver URL, tuned when a frequency is given. Each web-SDR
 * family has its own query syntax; unknown software gets the bare page.
 * @param {{url:string,type:string}} receiver
 * @param {{freqHz?: number, mode?: string}} [tune]
 * @returns {string}
 */
export function sdrTunedUrl(receiver, { freqHz, mode } = {}) {
  const base = receiver?.url;
  if (!base) return '';
  if (!Number.isFinite(freqHz) || freqHz <= 0) return base;
  const m = normalizeMode(mode);
  const khz = freqHz / 1000;
  const khzText = Number.isInteger(khz)
    ? String(khz)
    : khz.toFixed(3).replace(/\.?0+$/, '');
  const hz = Math.round(freqHz);
  const url = new URL(base);
  switch (receiver.type) {
    case 'kiwisdr':
    case 'web888':
      url.search = `?f=${khzText}${m}z8`;
      return url.href;
    case 'websdr':
      url.search = `?tune=${khzText}${m === 'nbfm' ? 'fm' : m === 'sam' ? 'sam-u' : m}`;
      return url.href;
    case 'openwebrx':
      url.hash = `freq=${hz},mod=${m}`;
      return url.href;
    case 'ubersdr':
      url.search = `?freq=${hz}&mode=${m}`;
      return url.href;
    case 'novasdr':
      url.search = `?frequency=${hz}&modulation=${m.toUpperCase()}`;
      return url.href;
    default:
      return base;
  }
}

export function createSdrOverlayEntry({ id, position, receiver }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: receiver.name,
    accent: sdrColor(receiver),
    priority: (receiver.usersMax || 0) * 100 + (receiver.bands ? 10 : 0),
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

export function selectSdrOverlayCohort(
  entries,
  limit = SDR_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(SDR_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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

export function createSdrSelectedOverlayEntry({
  id,
  position,
  receiver,
  tune = null,
}) {
  const details = [sdrTypeLabel(receiver)];
  const band = sdrBandText(receiver.bands);
  const specs = [band, receiver.antenna, receiver.hw].filter(Boolean);
  if (specs.length) details.push(specs.join(' · '));
  if (receiver.placeMismatchKm)
    details.push(
      `pin is ${receiver.placeMismatchKm} km from ${receiver.placeStated || 'the place in its name'} · position unverified`,
    );
  else if (receiver.placeDefault)
    details.push(
      'named with the software’s default location · the pin is the operator’s',
    );
  if (receiver.usersMax) details.push(`${receiver.usersMax} listener slots`);
  if (tune?.freqHz) {
    const covers = sdrCoversFrequency(receiver, tune.freqHz);
    details.push(
      `tune ${(tune.freqHz / 1e6).toFixed(3)} MHz ${String(tune.mode || SDR_DEFAULT_MODE).toUpperCase()}${
        covers === false ? ' · out of range' : ''
      }`,
    );
  }
  details.push(shortHost(receiver.url));
  details.push('click again: open receiver · esc: close');
  return {
    id: String(id),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: receiver.name,
    details,
    accent: SDR_COLORS.selected,
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

function shortHost(url) {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return '';
  }
}

export function mapSdrAnalystRecord(receiver, index = 0) {
  return {
    id: String(receiver?.id || `SDR-${String(index).padStart(4, '0')}`),
    name: receiver?.name ?? null,
    software: sdrTypeLabel(receiver),
    url: receiver?.url ?? null,
    lat: Number.isFinite(receiver?.lat) ? receiver.lat : null,
    lon: Number.isFinite(receiver?.lon) ? receiver.lon : null,
    bandLowHz: receiver?.bands?.[0] ?? null,
    bandHighHz: receiver?.bands?.[1] ?? null,
    antenna: receiver?.antenna ?? null,
    placeMismatchKm: receiver?.placeMismatchKm ?? null,
    placeStated: receiver?.placeStated ?? null,
  };
}

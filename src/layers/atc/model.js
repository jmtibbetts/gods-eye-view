import {
  ATC_COLORS,
  ATC_PHASES,
  ATC_PHASE_RULES,
  ATC_POSITIONS,
  ATC_POSITION_LABELS,
  liveAtcAirportUrl,
} from './policy.js';

const EARTH_KM = 6371;
const TO_RAD = Math.PI / 180;

/** Great-circle distance in km. */
export function atcDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * TO_RAD;
  const dLon = (lon2 - lon1) * TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * TO_RAD) * Math.cos(lat2 * TO_RAD) * Math.sin(dLon / 2) ** 2;
  return EARTH_KM * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

export function atcColor(airport) {
  if (!airport?.towered) return ATC_COLORS.untowered;
  return airport.hours === '24' ? ATC_COLORS.tower24 : ATC_COLORS.tower;
}

export function atcPositionLabel(position) {
  return ATC_POSITION_LABELS[position] || String(position || '');
}

/** "121.000" — always three decimals, the way pilots read them. */
export function atcMhzText(mhz) {
  return Number.isFinite(mhz) ? mhz.toFixed(3) : '';
}

/** Where the airport is: "Austin, TX" / "London, GB". */
export function atcPlaceText(airport) {
  if (!airport) return '';
  const region = airport.country === 'US' ? airport.region : airport.country;
  return [airport.city, region].filter(Boolean).join(', ');
}

/** "Austin Tower" / "Kennedy Ground" / "KGTU CTAF". */
export function atcFacilityName(airport, position) {
  const label = atcPositionLabel(position);
  if (!airport) return label;
  if (position === 'APP' || position === 'DEP') {
    if (airport.appCall) return `${airport.appCall} ${label}`;
  } else if (
    (position === 'TWR' || position === 'GND' || position === 'CLD') &&
    airport.call
  ) {
    return `${airport.call} ${label}`;
  }
  return `${airport.id} ${label}`;
}

/**
 * Nearest airports to a point.
 * @param {Iterable<object>} airports
 * @param {{lat:number, lon:number, toweredOnly?:boolean, query?:string, limit?:number, maxKm?:number}} query
 */
export function atcNearestAirports(
  airports,
  { lat, lon, toweredOnly = false, query = '', limit = 12, maxKm = Infinity },
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const out = [];
  for (const airport of airports) {
    if (toweredOnly && !airport.towered) continue;
    if (
      q &&
      !`${airport.id} ${airport.faa} ${airport.name} ${airport.city} ${airport.region} ${airport.call}`
        .toLowerCase()
        .includes(q)
    )
      continue;
    const km = atcDistanceKm(lat, lon, airport.lat, airport.lon);
    if (km > maxKm) continue;
    out.push([km, airport]);
  }
  return out
    .sort((a, b) => a[0] - b[0])
    .slice(0, Math.max(1, limit))
    .map(([km, airport]) => ({ ...airport, distanceKm: Math.round(km) }));
}

/** Nearest Center remote site to a point (null when the directory has none). */
export function atcNearestCenter(centers, lat, lon) {
  let best = null;
  let bestKm = Infinity;
  for (const center of centers) {
    const km = atcDistanceKm(lat, lon, center.lat, center.lon);
    if (km < bestKm) {
      bestKm = km;
      best = center;
    }
  }
  return best ? { ...best, distanceKm: Math.round(bestKm) } : null;
}

/**
 * Which controller a contact is talking to, from where it is relative to
 * the nearest towered field.
 *
 * @param {{altitudeFt?:number|null, onGround?:boolean, speedKt?:number|null, verticalFpm?:number|null}} contact
 * @param {{distanceKm:number, elevFt?:number|null, towered?:boolean}|null} airport
 * @returns {'ground'|'tower'|'departure'|'approach'|'center'}
 */
export function atcPhaseFor(contact, airport) {
  const rules = ATC_PHASE_RULES;
  if (!airport) return 'center';
  const km = Number(airport.distanceKm);
  const aglFt = Number.isFinite(contact?.altitudeFt)
    ? contact.altitudeFt - (airport.elevFt || 0)
    : null;
  const slow =
    Number.isFinite(contact?.speedKt) && contact.speedKt < rules.groundSpeedKt;
  if (
    contact?.onGround ||
    (km <= 4 && aglFt !== null && aglFt < 300) ||
    (km <= 4 && slow && aglFt !== null && aglFt < 1500)
  )
    return km <= 6 ? 'ground' : 'center';
  if (km <= rules.towerRadiusKm && (aglFt === null || aglFt < rules.towerAglFt))
    return 'tower';
  if (
    km <= rules.approachRadiusKm &&
    (aglFt === null || aglFt < rules.approachAglFt)
  ) {
    const climbing =
      Number.isFinite(contact?.verticalFpm) &&
      contact.verticalFpm > rules.climbFpm;
    return climbing ? 'departure' : 'approach';
  }
  return 'center';
}

/**
 * Pick the frequency to listen to for a position at an airport — the
 * primary entry first, then any sectorised one, then a sensible fallback
 * (Tower → CTAF at an untowered field; Departure → Approach; Ground → Tower).
 * @returns {{position:string, mhz:number, sector:string, secondary:boolean}|null}
 */
export function atcFrequencyFor(airport, position) {
  const freqs = airport?.freqs || [];
  const pick = (code) =>
    freqs.find((f) => f.position === code && !f.secondary && !f.sector) ||
    freqs.find((f) => f.position === code && !f.secondary) ||
    freqs.find((f) => f.position === code) ||
    null;
  const chain = {
    TWR: ['TWR', 'CTAF', 'AFIS', 'INFO', 'UNICOM'],
    GND: ['GND', 'TWR', 'CTAF', 'UNICOM'],
    CLD: ['CLD', 'GND', 'TWR'],
    APP: ['APP', 'DEP', 'TWR', 'CTAF'],
    DEP: ['DEP', 'APP', 'TWR', 'CTAF'],
    CTR: ['CTR', 'APP'],
    ATIS: ['ATIS', 'WX'],
  }[position] || [position];
  for (const code of chain) {
    const found = pick(code);
    if (found) return found;
  }
  return null;
}

/** Above this a Center works the contact on its high-altitude sector. */
export const ATC_HIGH_SECTOR_FT = 24_000;

/**
 * The Center sector frequency for a contact's altitude: LOW below FL240,
 * HIGH above it, ULTRA-HIGH above FL350 where a site has one; a site's
 * only frequency otherwise.
 * @param {{freqs: Array<{mhz:number, sector?:string}>}} center
 * @param {number|null} altitudeFt
 * @returns {object|null}
 */
export function atcCenterFrequencyFor(center, altitudeFt) {
  const freqs = center?.freqs || [];
  if (!freqs.length) return null;
  const alt = Number(altitudeFt);
  const band = !Number.isFinite(alt)
    ? null
    : alt >= 35_000
      ? 'ULTRA-HIGH'
      : alt >= ATC_HIGH_SECTOR_FT
        ? 'HIGH'
        : 'LOW';
  const sectorOf = (f) => String(f.sector || '').toUpperCase();
  const order =
    band === 'ULTRA-HIGH'
      ? ['ULTRA-HIGH', 'HIGH', 'LOW/HIGH', 'LOW']
      : band === 'HIGH'
        ? ['HIGH', 'LOW/HIGH', 'ULTRA-HIGH', 'LOW']
        : ['LOW', 'LOW/HIGH', 'HIGH', 'ULTRA-HIGH'];
  for (const wanted of order) {
    const found = freqs.find((f) => sectorOf(f) === wanted);
    if (found) return found;
  }
  return freqs[0];
}

/**
 * Resolve the follow target for a contact: the airport, phase and frequency.
 * The approach position is taken from the field's approach provider when
 * the directory names one (Georgetown's approach is Austin's TRACON).
 *
 * @param {object} contact  {lat, lon, altitudeFt, onGround, speedKt, verticalFpm}
 * @param {{airports: Map<string, object>|Iterable<object>, byFaa?: Map<string, object>, centers?: object[]}} directory
 * @returns {{airport: object|null, phase: string, position: string, frequency: object|null, center: object|null}}
 */
export function atcFollowTarget(contact, directory) {
  const airports =
    directory.airports instanceof Map
      ? directory.airports.values()
      : directory.airports;
  const [nearest] = atcNearestAirports(airports, {
    lat: contact.lat,
    lon: contact.lon,
    toweredOnly: true,
    limit: 1,
  });
  const phase = atcPhaseFor(contact, nearest || null);
  let position = ATC_PHASES[phase].position;
  let airport = nearest || null;
  let center = null;
  if (phase === 'center') {
    center = directory.centers?.length
      ? atcNearestCenter(directory.centers, contact.lat, contact.lon)
      : null;
    if (center) {
      const frequency = atcCenterFrequencyFor(center, contact.altitudeFt);
      return { airport, phase, position: 'CTR', frequency, center };
    }
    // No Center data (outside the US): fall back to the nearest approach.
    position = 'APP';
  }
  if (
    (position === 'APP' || position === 'DEP') &&
    airport?.appProvider &&
    airport.appProvider !== airport.faa &&
    directory.byFaa?.has(airport.appProvider)
  ) {
    const provider = directory.byFaa.get(airport.appProvider);
    const viaProvider = atcFrequencyFor(provider, position);
    if (viaProvider)
      return {
        airport: { ...provider, distanceKm: airport.distanceKm },
        phase,
        position,
        frequency: viaProvider,
        center: null,
      };
  }
  return {
    airport,
    phase,
    position,
    frequency: airport ? atcFrequencyFor(airport, position) : null,
    center: null,
  };
}

/** Parse the flat-text context properties a tracked contact publishes. */
export function atcContactFromContext(record) {
  if (!record || !Number.isFinite(record.latitude)) return null;
  const p = record.properties || {};
  const altText = String(p.altitude || '');
  const onGround = /ground/i.test(altText);
  const altitudeFt = onGround
    ? 0
    : Number.parseFloat(altText.replace(/[^\d.-]/g, '')) || null;
  const speedKt = Number.parseFloat(
    String(p.speed || '').replace(/[^\d.]/g, ''),
  );
  return {
    id: String(record.id),
    layerId: record.layerId,
    label: record.label || String(record.id),
    lat: record.latitude,
    lon: record.longitude,
    altitudeFt,
    onGround,
    speedKt: Number.isFinite(speedKt) ? speedKt : null,
    route: p.route || '',
    verticalFpm: null,
  };
}

export function createAtcOverlayEntry({ id, position, airport }) {
  const primary = atcFrequencyFor(airport, 'TWR');
  return {
    id: String(id),
    position,
    variant: 'label',
    title: primary ? `${airport.id} · ${atcMhzText(primary.mhz)}` : airport.id,
    accent: atcColor(airport),
    priority:
      (airport.towered ? 1000 : 0) +
      (airport.hours === '24' ? 100 : 0) +
      airport.freqs.length,
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

export function createAtcSelectedOverlayEntry({
  id,
  position,
  airport,
  listening = null,
}) {
  const details = [];
  details.push(
    [
      atcPlaceText(airport),
      airport.towered
        ? `tower ${airport.hours === '24' ? '24 h' : airport.hours || 'part time'}`
        : 'no tower',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const byPosition = new Map();
  for (const f of airport.freqs) {
    if (f.secondary || byPosition.has(f.position)) continue;
    byPosition.set(f.position, f);
  }
  const line = [];
  for (const code of ATC_POSITIONS) {
    const f = byPosition.get(code);
    if (f) line.push(`${atcPositionLabel(code)} ${atcMhzText(f.mhz)}`);
    if (line.length >= 5) break;
  }
  if (line.length) details.push(line.join(' · '));
  if (listening?.frequency)
    details.push(
      `listening ${atcFacilityName(airport, listening.position)} ${atcMhzText(listening.frequency.mhz)}`,
    );
  details.push('click again: listen · esc: close');
  return {
    id: String(id),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: `${airport.id} · ${airport.name}`,
    details,
    accent: ATC_COLORS.selected,
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

export function mapAtcAnalystRecord(airport, index = 0) {
  const freqs = {};
  for (const f of airport?.freqs || []) {
    if (f.secondary) continue;
    const key = atcPositionLabel(f.position).toLowerCase();
    if (!freqs[key]) freqs[key] = atcMhzText(f.mhz);
  }
  return {
    id: String(airport?.id || `ATC-${String(index).padStart(4, '0')}`),
    name: airport?.name ?? null,
    place: atcPlaceText(airport),
    towered: Boolean(airport?.towered),
    towerHours: airport?.hours || null,
    call: airport?.call || null,
    lat: Number.isFinite(airport?.lat) ? airport.lat : null,
    lon: Number.isFinite(airport?.lon) ? airport.lon : null,
    liveAtcUrl: liveAtcAirportUrl(airport?.id),
    ...freqs,
  };
}

/**
 * HF radiofax — the weather charts, and where to actually find them.
 *
 * A dozen government stations transmit surface analyses, wind and wave
 * charts and ice edges by shortwave facsimile, around the clock, for ships
 * with no satellite link. They are the oldest live data in this app and
 * still the most reliable thing at sea.
 *
 * TWO THINGS MAKE THIS EASY TO GET WRONG, and both are why the frequencies
 * here were researched rather than remembered.
 *
 * The dial is not the published frequency. Radiofax is received as SSB, and
 * the published number is the carrier: the picture sits on subcarriers above
 * it (1.5 kHz black, 2.3 kHz white). Tune the published number in USB and
 * you get noise. The convention is 1.9 kHz BELOW it, which is what
 * `wefaxDialHz` does, so a caller never has to know.
 *
 * And a station is not on all of its frequencies all day. Several are
 * scheduled — Boston's 4235 kHz runs overnight and its 12750 kHz runs
 * afternoons — so asking for the wrong one gets silence that looks exactly
 * like a dead band.
 *
 * WHAT THIS DOES NOT DO. It does not know which CHART is transmitting at any
 * moment. Each station rotates through a schedule of products, and that
 * schedule is long, station-specific, and revised; encoding it would be a
 * promise this could not keep. Tuning a station tells you it is a station
 * sending charts, not which chart is arriving.
 *
 * Frequencies and windows are from the NWS Worldwide Marine Radiofacsimile
 * Broadcast Schedules. Transmitter positions are approximate — they are used
 * to pick the station whose charts cover a ship, not to point an antenna.
 *
 * PURE module — no Cesium, no DOM, node-testable.
 */

/**
 * How far below the published frequency the dial goes, in USB.
 * See the note above: this is the difference between a chart and noise.
 */
export const WEFAX_USB_OFFSET_HZ = -1_900;

/** Where to set the receiver for a published radiofax frequency. */
export const wefaxDialHz = (assignedHz) =>
  Math.max(0, Math.round(Number(assignedHz) + WEFAX_USB_OFFSET_HZ));

/**
 * A frequency's daily window in UTC minutes, or null for around the clock.
 * `[start, end]` with start > end means the window crosses midnight.
 */
const always = null;

/**
 * The stations, with their published frequencies in kHz.
 *
 * @type {ReadonlyArray<{call:string, name:string, lat:number, lon:number,
 *   region:string, freqs: ReadonlyArray<{khz:number, window:[number,number]|null}>}>}
 */
export const WEFAX_STATIONS = Object.freeze([
  Object.freeze({
    call: 'NMF',
    name: 'US Coast Guard Boston',
    region: 'North Atlantic',
    lat: 41.7,
    lon: -70.5,
    freqs: Object.freeze([
      { khz: 4235, window: [150, 639] },
      { khz: 6340.5, window: always },
      { khz: 9110, window: always },
      { khz: 12750, window: [840, 1359] },
    ]),
  }),
  Object.freeze({
    call: 'NMG',
    name: 'US Coast Guard New Orleans',
    region: 'Gulf of Mexico and western Atlantic',
    lat: 29.9,
    lon: -90.1,
    freqs: Object.freeze([
      { khz: 4317.9, window: always },
      { khz: 8503.9, window: always },
      { khz: 12789.9, window: always },
      { khz: 17146.4, window: [720, 1245] },
    ]),
  }),
  Object.freeze({
    call: 'NMC',
    name: 'US Coast Guard Point Reyes',
    region: 'Eastern and central Pacific',
    lat: 38.1,
    lon: -122.8,
    freqs: Object.freeze([
      { khz: 4346, window: [100, 968] },
      { khz: 8682, window: always },
      { khz: 12786, window: always },
      { khz: 17151.2, window: always },
      { khz: 22527, window: [1120, 1436] },
    ]),
  }),
  Object.freeze({
    call: 'NOJ',
    name: 'US Coast Guard Kodiak',
    region: 'Alaska and the Bering Sea',
    lat: 57.8,
    lon: -152.4,
    freqs: Object.freeze([
      { khz: 2054, window: always },
      { khz: 4298, window: always },
      { khz: 8459, window: always },
      { khz: 12412.5, window: always },
    ]),
  }),
  Object.freeze({
    call: 'KVM70',
    name: 'NWS Honolulu',
    region: 'Central and western Pacific',
    lat: 21.3,
    lon: -157.9,
    freqs: Object.freeze([
      { khz: 9982.5, window: [319, 956] },
      { khz: 11090, window: always },
      // Crosses midnight UTC, which is why windows are allowed to wrap.
      { khz: 16135, window: [1039, 236] },
    ]),
  }),
  Object.freeze({
    call: 'GYA',
    name: 'Royal Navy Northwood',
    region: 'North Atlantic and European waters',
    lat: 51.6,
    lon: -0.4,
    freqs: Object.freeze([
      { khz: 2618.5, window: always },
      { khz: 4610, window: always },
      { khz: 8040, window: always },
      { khz: 11086.5, window: always },
    ]),
  }),
  Object.freeze({
    call: 'DDH/DDK',
    name: 'Deutscher Wetterdienst Pinneberg',
    region: 'North Sea, Baltic and North Atlantic',
    lat: 53.7,
    lon: 9.8,
    freqs: Object.freeze([
      { khz: 3855, window: always },
      { khz: 7880, window: always },
      { khz: 13882.5, window: always },
    ]),
  }),
  Object.freeze({
    call: 'JMH',
    name: 'Japan Meteorological Agency Tokyo',
    region: 'Northwest Pacific',
    lat: 35.7,
    lon: 139.8,
    freqs: Object.freeze([
      { khz: 3622.5, window: always },
      { khz: 7795, window: always },
      { khz: 13988.5, window: always },
    ]),
  }),
  Object.freeze({
    call: 'JFX',
    name: 'Kagoshima',
    region: 'Northwest Pacific and East China Sea',
    lat: 31.6,
    lon: 130.6,
    freqs: Object.freeze([
      { khz: 4274, window: always },
      { khz: 8658, window: always },
      { khz: 13074, window: always },
      { khz: 16907.5, window: always },
      { khz: 22559.6, window: always },
    ]),
  }),
  Object.freeze({
    call: 'VMC',
    name: 'Bureau of Meteorology Charleville',
    region: 'Eastern Australia and the Coral Sea',
    lat: -26.4,
    lon: 146.3,
    freqs: Object.freeze([
      { khz: 2628, window: always },
      { khz: 5100, window: always },
      { khz: 11030, window: always },
      { khz: 13920, window: always },
      { khz: 20469, window: always },
    ]),
  }),
  Object.freeze({
    call: 'VMW',
    name: 'Bureau of Meteorology Wiluna',
    region: 'Western Australia and the eastern Indian Ocean',
    lat: -26.6,
    lon: 120.2,
    freqs: Object.freeze([
      { khz: 5755, window: always },
      { khz: 7535, window: always },
      { khz: 10555, window: always },
      { khz: 15615, window: always },
      { khz: 18060, window: always },
    ]),
  }),
  Object.freeze({
    call: 'RBW',
    name: 'Murmansk',
    region: 'Barents Sea and the Northern Sea Route',
    lat: 69.0,
    lon: 33.1,
    freqs: Object.freeze([{ khz: 5336, window: always }]),
  }),
]);

/** Minutes past midnight UTC for a Date. */
export const utcMinutes = (date) =>
  date.getUTCHours() * 60 + date.getUTCMinutes();

/**
 * Whether a frequency is transmitting at this UTC minute.
 * A window that starts after it ends wraps through midnight.
 */
export function withinWindow(window, minutes) {
  if (!window) return true;
  const [start, end] = window;
  return start <= end
    ? minutes >= start && minutes <= end
    : minutes >= start || minutes <= end;
}

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The station whose charts cover a position — nearest by transmitter.
 *
 * Nearest is a proxy for "covers this water", and a good one: the stations
 * were sited to serve their own sea areas. It is not a coverage model, and
 * a ship halfway between two of them may do better on the other.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {{station: object, distanceKm: number}|null}
 */
export function nearestWefaxStation(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  for (const station of WEFAX_STATIONS) {
    const km = distanceKm(lat, lon, station.lat, station.lon);
    if (!best || km < best.distanceKm)
      best = { station, distanceKm: Math.round(km) };
  }
  return best;
}

/** The station's frequencies transmitting at this time, in kHz order. */
export function activeFrequencies(station, now = new Date()) {
  const minutes = utcMinutes(now instanceof Date ? now : new Date(now));
  return (station?.freqs || [])
    .filter((entry) => withinWindow(entry.window, minutes))
    .map((entry) => entry.khz)
    .sort((a, b) => a - b);
}

/**
 * Preferred order for trying a station's frequencies.
 *
 * Nearest 8 MHz first. HF propagation swings with the hour and the sunspot
 * cycle and this does not model either — the middle of the band is simply
 * the least bad single guess, and the caller is told to try the others.
 */
export function preferredFrequencies(station, now = new Date()) {
  return activeFrequencies(station, now).sort(
    (a, b) => Math.abs(a - 8000) - Math.abs(b - 8000),
  );
}

/**
 * Choose a radiofax station and dial frequency for a position.
 *
 * @param {object} options
 * @param {number} options.lat
 * @param {number} options.lon
 * @param {Date} [options.now]
 * @param {(dialHz: number) => Array<object>} [options.receiversFor] Candidate
 *   receivers covering a dial frequency, nearest first. Omit to skip the
 *   coverage check and take the preferred frequency.
 * @returns {{station: object, khz: number, dialHz: number, distanceKm: number,
 *   receiver: object|null, alternatives: number[]}|null}
 */
export function chooseWefax({ lat, lon, now = new Date(), receiversFor }) {
  const nearest = nearestWefaxStation(lat, lon);
  if (!nearest) return null;
  const order = preferredFrequencies(nearest.station, now);
  if (!order.length) return null;
  for (const khz of order) {
    const dialHz = wefaxDialHz(khz * 1000);
    const receiver = receiversFor ? (receiversFor(dialHz) || [])[0] : null;
    if (receiversFor && !receiver) continue;
    return {
      station: nearest.station,
      khz,
      dialHz,
      distanceKm: nearest.distanceKm,
      receiver: receiver || null,
      alternatives: order.filter((entry) => entry !== khz),
    };
  }
  return null;
}

/**
 * What to tell someone who has just opened a radiofax frequency.
 * Names the offset, because a dial 1.9 kHz off the published number looks
 * like a mistake until you know why.
 */
export function wefaxNoticeText(choice) {
  if (!choice) return '';
  const others = choice.alternatives.length
    ? ` Also on ${choice.alternatives.map((khz) => `${khz} kHz`).join(', ')} if this one is not propagating.`
    : '';
  return `${choice.station.call} — ${choice.station.name}, ${choice.station.region}. Published ${choice.khz} kHz; the dial sits 1.9 kHz low in USB, which is how radiofax is tuned.${others} Charts arrive on the station's own rotation, and decoding the picture needs software this app does not have.`;
}

/**
 * SDR layer policy — public web-accessible software-defined radio receivers
 * (KiwiSDR, WebSDR, OpenWebRX, UberSDR, NovaSDR, Web-888).
 *
 * Every receiver is someone's antenna on someone's home bandwidth, exposed
 * through its own web UI. The layer places them on the globe from a bundled
 * directory snapshot and hands the user off to the receiver's page — tuned
 * to a frequency when asked — rather than relaying audio itself. That keeps
 * each operator's user limits and terms exactly where they set them.
 */

export const SDR_LAYER_ID = 'sdr';
export const SDR_ENTITY_PREFIX = 'sdr:';

/** Bundled directory (see src/data/local_data/sdr_receivers/source.json). */
export const SDR_DIRECTORY_URL = new URL(
  '../../data/local_data/sdr_receivers/receivers.json',
  import.meta.url,
).href;

export const SDR_FETCH_TIMEOUT_MS = 12_000;

export const SDR_OVERLAY_SOURCE_ID = 'sdr';
export const SDR_SELECTED_OVERLAY_SOURCE_ID = 'sdr-selected';
export const SDR_OVERLAY_COHORT_LIMIT = 40;
export const SDR_OVERLAY_COLLISION_CAPACITY = 24;
export const SDR_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Marker colour by receiver software. */
export const SDR_COLORS = Object.freeze({
  kiwisdr: '#7cff6b',
  websdr: '#ffd24d',
  openwebrx: '#4db8ff',
  ubersdr: '#ff8bd1',
  novasdr: '#c9a0ff',
  web888: '#7cff6b',
  sdr: '#b0bec5',
  selected: '#00ffff',
});

export const SDR_TYPE_LABELS = Object.freeze({
  kiwisdr: 'KiwiSDR',
  websdr: 'WebSDR',
  openwebrx: 'OpenWebRX',
  ubersdr: 'UberSDR',
  novasdr: 'NovaSDR',
  web888: 'Web-888',
  sdr: 'SDR',
});

/** Modes accepted by the tune helper (normalised to each software's syntax). */
export const SDR_MODES = Object.freeze([
  'am',
  'usb',
  'lsb',
  'cw',
  'nbfm',
  'sam',
]);
export const SDR_DEFAULT_MODE = 'am';

import * as Cesium from 'cesium';
import { satelliteClassColor } from '../../data/satelliteClass.js';

/**
 * Satellite Orbits — Real-time positions via CelesTrak TLE + SGP4 propagation.
 *
 * Loads six CelesTrak groups (~840 sats): stations, visual, GPS, GLONASS,
 * Galileo, and the geosynchronous belt. Optional dense mode (setParams
 * catalog:'dense') adds the Starlink shell as points-only extras.
 * Renders positions via PointPrimitiveCollection, orbital paths as polylines.
 * Click any satellite to track it with camera follow + orbital path.
 *
 * ISS gets special treatment: larger point, persistent host label, path shown by default.
 */

export const ISS_NORAD = 25544;

/**
 * NASA's live stream from the International Space Station.
 *
 * WHAT THIS ACTUALLY IS, because the obvious name for it would overclaim. The
 * HDEV experiment — the dedicated external Earth-viewing cameras that ran a
 * continuous downward view — was decommissioned years ago. What NASA streams
 * now alternates between external views, mission coverage and, between
 * broadcasts, a holding card. So this is labelled a live stream rather than a
 * camera: a reader who opens it expecting a guaranteed view of the Earth below
 * and gets a press conference has been misled by the button, not by NASA.
 *
 * The embed host is youtube-nocookie.com, which is the tracking-free variant
 * and already the allowlisted host elsewhere in this project.
 *
 * ROT RISK: NASA re-creates this stream periodically and the video id changes
 * with it. When that happens the dock shows YouTube's own unavailable card and
 * its POP OUT button still reaches the channel, so the failure is visible and
 * escapable rather than silent. ISS_STREAM_CHANNEL_URL below is the rot-proof
 * alternative — it follows whatever NASA has live — at the cost of showing
 * general NASA coverage rather than the ISS feed specifically.
 */
export const ISS_STREAM_URL =
  'https://www.youtube-nocookie.com/embed/awQzjn72bI0';

/** NASA's channel live feed: survives id rotation, less specific. */
export const ISS_STREAM_CHANNEL_URL =
  'https://www.youtube-nocookie.com/embed/live_stream?channel=UCLA_DiR1FfKNvjuUpBHmylQ';

export const ISS_STREAM_TITLE = 'NASA ISS LIVE STREAM';
export const ISS_STREAM_NOTE =
  'NASA’s live feed — external views when available, mission coverage otherwise.';

export const ISS_OVERLAY_SOURCE_ID = 'satellites-iss';

export const ISS_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: true,
  solveIntervalMs: 125,
});

export const ORBIT_PATH_STEPS = 180;
// points per orbital path

export const POSITION_UPDATE_MS = 1000;
// re-propagate every 1s (SGP4 is smooth at this rate)

export const RING_ROTATION_MS = 1000;
// re-align baked orbit rings to current GMST every 1s

/**
 * CelesTrak groups loaded as the core catalog, in dedupe-priority order:
 * a satellite that appears in multiple groups keeps the FIRST (most specific)
 * tag. `path` is the upstream GROUP name forwarded by the /api/celestrak
 * proxy; `tag` is the internal group key used for POINT_STYLES lookup.
 * Note: CelesTrak's GLONASS group is named 'glo-ops' (not
 * 'glonass-operational' — that name 404s upstream).
 */

export const CATALOG_GROUPS = [
  { tag: 'stations', path: 'stations' },
  // Earth observation ahead of `visual` and `geo` on purpose: Terra and Aqua
  // are also in the visual group, and the weather birds are also in the
  // geostationary belt. First tag wins, and what these satellites DO — image
  // the Earth — is the more useful thing to say about them.
  { tag: 'weather', path: 'weather' },
  { tag: 'resource', path: 'resource' },
  { tag: 'visual', path: 'visual' },
  { tag: 'gps-ops', path: 'gps-ops' },
  { tag: 'glonass', path: 'glo-ops' },
  { tag: 'galileo', path: 'galileo' },
  { tag: 'geo', path: 'geo' },
];

// Dense-catalog mode (setParams({ catalog: 'dense' })): Starlink shell as
// points-only extras — no labels, no detection-overlay participation, and a
// relaxed propagation budget (round-robin, ~1/5 of core cadence per sat).

export const DENSE_GROUP_PATH = 'starlink';

export const DENSE_REFRESH_FRAMES = 300;
// full dense pass spread over ~300 frames (~5s @ 60fps)

export const DENSE_CREATE_CHUNK = 1500;
// satrec builds per macro-task while loading

/**
 * Tracked-entity camera offset, east-north-up meters (Entity.viewFrom).
 * Magnitude ≈ 726 km — the user-validated "slightly zoomed out" framing for
 * LEO: far enough that per-frame satellite motion doesn't stutter the camera
 * or smear the label, with +Z biasing the view down onto the satellite.
 * High orbits (MEO nav / GEO belt) scale this up so the ring stays in frame.
 */

export const TRACK_VIEW_FROM_LEO = new Cesium.Cartesian3(
  -450000,
  -450000,
  350000,
);

export const HIGH_ORBIT_ALTITUDE_M = 2000000;

export const TRACK_VIEW_FROM_HIGH_SCALE = 4;
// ≈ 2900 km back for MEO/GEO

/**
 * Tracked-camera offset for a geostationary IMAGER, east-north-up metres in
 * the entity's own ENU frame (see TRACK_VIEW_FROM_GEO_IMAGER_FRAME). The
 * default satellite framing looks along the belt, which for a parked imager
 * shows a dot against black; this parks the camera ~4,600 km straight
 * out from the satellite looking back through it, so the disk it stares at
 * fills the middle of the view with the dot on top of it.
 */
export const TRACK_VIEW_FROM_GEO_IMAGER = new Cesium.Cartesian3(
  0,
  -800000,
  4500000,
);

/**
 * Satellites are auto-tracked in a velocity-aligned frame, which is right for
 * a dot crossing the sky and wrong for a parked one: its "forward" is east
 * along the belt. A geostationary imager is tracked in ENU so "up" is away
 * from the ground it images.
 */
export const TRACK_VIEW_FROM_GEO_IMAGER_FRAME =
  Cesium.TrackingReferenceFrame.ENU;

/**
 * Shared per-group point styling — single source of truth used by BOTH the
 * creation site (update) and tracking restore (_clearTracking) so deselecting
 * a satellite never loses the original palette (WS-D3).
 *
 * Colors come from `satelliteClass.js` so the dot, the class label on the
 * card, and the legend swatch on the layer row can never disagree. Only
 * pixelSize/outline live here — those encode per-group prominence, not class.
 * Converted once at module load; per-point color is a plain primitive
 * attribute, so classification costs nothing per frame.
 */

export const POINT_OUTLINE = Cesium.Color.WHITE.withAlpha(0.3);

export const _classColor = (group) =>
  Cesium.Color.fromCssColorString(satelliteClassColor(group));

export const POINT_STYLES = {
  // The ISS keeps its own long-standing red hero styling rather than the
  // STATION class color: it is the object most users open this layer for, it
  // carries a permanent name label, and its size/outline already set it apart.
  // Its card still reads "STATION · ISS", so the class stays legible.
  iss: {
    pixelSize: 12,
    color: Cesium.Color.fromCssColorString('#ff4444'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 2,
  },
  stations: {
    pixelSize: 8,
    color: _classColor('stations'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  visual: {
    pixelSize: 6,
    color: _classColor('visual'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  // Nav constellations (GPS / GLONASS / Galileo) resolve to one shared NAV
  // color; 6px so the MEO shells read as clearly as the old visual group did.
  'gps-ops': {
    pixelSize: 6,
    color: _classColor('gps-ops'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  glonass: {
    pixelSize: 6,
    color: _classColor('glonass'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  galileo: {
    pixelSize: 6,
    color: _classColor('galileo'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  geo: {
    pixelSize: 5,
    color: _classColor('geo'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  // Earth observation: one EARTH OBS colour for both groups, 7 px so an
  // imaging satellite is findable — it is the one you click for a SENSORS
  // panel, and there are only ~240 of them among 800 dots.
  weather: {
    pixelSize: 7,
    color: _classColor('weather'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  resource: {
    pixelSize: 7,
    color: _classColor('resource'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  // Dense-mode extras (Starlink): dim, small, points-only.
  dense: {
    pixelSize: 3,
    color: _classColor('dense').withAlpha(0.9),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
};

/**
 * Physically DOCKED vehicles are separate real tracks sharing one position: the
 * station and everything berthed to it sit within metres of each other. Their
 * ambient labels therefore stack underneath the tracked card, which is what the
 * owner saw. This radius is deliberately tight — it must catch a docked stack
 * and nothing else, so an unrelated satellite in a similar orbit is never
 * suppressed. Formation-flying pairs are km apart; a docked stack is ~100 m.
 */

export const DOCKED_COMPANION_RADIUS_M = 2000;

/** The scan is O(points); the tracked label is rebuilt every frame, so throttle. */

export const DOCKED_SCAN_INTERVAL_MS = 1000;

/**
 * Shared-context refresh interval. The tracked satellite is re-propagated
 * every rendered frame; the voice context only needs to be current to about
 * the propagation cadence, so this refreshes on the same 1 s beat instead of
 * allocating a record 60 times a second.
 */

export const CONTEXT_REFRESH_INTERVAL_MS = 1000;

/**
 * Sensor footprint under a tracked imaging satellite (footprint.js).
 *
 * The strip runs back three minutes along the ground track — about 1,300 km
 * for a low orbiter, enough to read as "the picture being laid down" without
 * wrapping a hemisphere — sampled every 15 s, and is rebuilt on the same
 * one-second beat as everything else here. A geostationary imager gets a
 * disk instead: 60° of Earth-central angle is roughly what an ABI or SEVIRI
 * full-disk scan covers before the limb foreshortens it to nothing.
 */
export const FOOTPRINT_TRAIL_SECONDS = 180;
export const FOOTPRINT_TRAIL_STEPS = 12;
export const FOOTPRINT_REFRESH_MS = 1000;
export const FOOTPRINT_DISK_RADIUS_M = 6371008.8 * Cesium.Math.toRadians(60);
/** The EARTH OBS class colour, so the footprint reads as that satellite's. */
export const FOOTPRINT_COLOR = satelliteClassColor('resource');

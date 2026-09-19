import test from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import {
  IMAGING_PLATFORMS,
  imagingPlatformFor,
  swathKmFor,
} from './sensors.js';
import { ALL_IMAGERY_PRODUCTS } from '../imageryOverlays/catalog.js';
import { createSatellitesLayer } from './index.js';
import { createSatelliteSource } from './source.js';
import {
  CATALOG_GROUPS,
  FOOTPRINT_DISK_RADIUS_M,
  FOOTPRINT_TRAIL_STEPS,
  TRACK_VIEW_FROM_GEO_IMAGER,
  TRACK_VIEW_FROM_GEO_IMAGER_FRAME,
} from './policy.js';
import * as Cesium from 'cesium';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as readout from '../../data/trackedReadout.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';
import * as layerStateService from '../../data/layerState.js';

// Live CelesTrak elements, epoch 2026-09-19. Only the shape of the orbit
// matters here, never where the satellite is on a given day.
const NOAA20 = twoline2satrec(
  '1 43013U 17073A   26262.24111710  .00000040  00000+0  39795-4 0  9994',
  '2 43013  98.7821 200.8849 0001386  44.7303 315.3984 14.19526567457812',
);
const GOES19 = twoline2satrec(
  '1 60133U 24119A   26262.26457023 -.00000253  00000+0  00000+0 0  9996',
  '2 60133   0.0324  14.9261 0000298 235.8372 127.4756  1.00271875  7905',
);
const ISS = twoline2satrec(
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
);

test('every imaging platform names a product platform the imagery catalog serves, or links out', () => {
  // A platform string that matches nothing in the catalog is a satellite the
  // panel would list with an empty band list and no explanation. Either the
  // catalog draws something for it or the entry says where its data lives.
  const served = new Set(ALL_IMAGERY_PRODUCTS.map((p) => p.platform));
  for (const platform of IMAGING_PLATFORMS) {
    const hits = platform.platforms.filter((name) => served.has(name));
    const strays = platform.platforms.filter((name) => !served.has(name));
    assert.deepEqual(strays, [], `${platform.name} names unknown ${strays}`);
    assert.ok(
      hits.length || platform.link || platform.norad === 25544,
      `${platform.name} has no product and no link`,
    );
  }
});

test('platforms are unique by NORAD number and each describes at least one instrument', () => {
  const seen = new Set();
  for (const platform of IMAGING_PLATFORMS) {
    assert.ok(Number.isInteger(platform.norad), platform.name);
    assert.ok(!seen.has(platform.norad), `${platform.norad} listed twice`);
    seen.add(platform.norad);
    assert.ok(platform.instruments.length >= 1, platform.name);
    assert.ok(
      ['polar', 'geostationary', 'low Earth'].includes(platform.orbit),
      `${platform.name}: ${platform.orbit}`,
    );
    for (const instrument of platform.instruments) {
      assert.ok(instrument.name && instrument.fullName, platform.name);
      assert.ok(instrument.reveals, `${platform.name} ${instrument.name}`);
      if (platform.orbit === 'geostationary')
        assert.equal(instrument.swathKm ?? null, null, instrument.name);
    }
  }
  assert.equal(imagingPlatformFor('43013')?.name, 'NOAA-20');
  assert.equal(imagingPlatformFor(1), null);
  assert.equal(imagingPlatformFor(undefined), null);
});

test('the widest imager sets the swath; a disk-staring platform has none', () => {
  assert.equal(swathKmFor(imagingPlatformFor(43013)), 3060);
  assert.equal(swathKmFor(imagingPlatformFor(25994)), 2330);
  assert.equal(swathKmFor(imagingPlatformFor(60133)), null);
  assert.equal(swathKmFor(null), null);
});

test('the catalog groups the layer loads cover every imaging platform', () => {
  // A platform the panel offers to TRACK has to arrive with the catalog, or
  // the button follows nothing. Weather and resource are the CelesTrak groups
  // that carry the polar imagers; GEO carries the parked ones.
  const tags = CATALOG_GROUPS.map((g) => g.tag);
  for (const tag of ['weather', 'resource', 'geo', 'stations'])
    assert.ok(tags.includes(tag), `${tag} not loaded: ${tags}`);
  // First tag wins when a satellite is in several groups, so the imagers must
  // be tagged by what they do before `visual` and `geo` can claim them.
  assert.ok(tags.indexOf('weather') < tags.indexOf('visual'));
  assert.ok(tags.indexOf('resource') < tags.indexOf('geo'));
});

test('the source lets every catalog group through', async () => {
  // The source confines requests to a known set of groups, so a group added
  // to the catalog but not to the source is silently "unavailable" on every
  // load — which is exactly how the imaging fleet first failed to arrive.
  const asked = [];
  const source = createSatelliteSource({
    fetchImpl: async (url) => {
      asked.push(url);
      return { ok: true, status: 200, text: async () => '' };
    },
  });
  for (const { path } of CATALOG_GROUPS) {
    await assert.doesNotReject(() => source.readGroup(path), path);
  }
  assert.equal(asked.length, CATALOG_GROUPS.length);
});

/** The satellites layer without a scene, with a viewer double for entities. */
function buildLayer() {
  const services = Object.fromEntries(
    [
      'picking',
      'focus',
      'readout',
      'overlays',
      'context',
      'render',
      'layerState',
    ].map((key) => [key, {}]),
  );
  services.layerState.isExplicitLayerStateOrigin = () => false;
  const layer = createSatellitesLayer({ source: { readGroup() {} }, services });
  const added = [];
  const removed = [];
  const viewer = {
    entities: {
      add(entity) {
        added.push(entity);
        return entity;
      },
      remove(entity) {
        removed.push(entity);
      },
    },
  };
  return { layer, added, removed, viewer };
}

test('a polar imager gets a swath strip that runs back along its ground track', () => {
  const { layer } = buildLayer();
  const footprint = layer._footprintForTest();
  const now = new Date(Date.UTC(2026, 8, 19, 12, 0, 0));
  const ring = footprint.swathRing(NOAA20, now, 3060);
  assert.ok(ring, 'propagation succeeded');
  // Left edge and right edge, one pair per sample, as a flat lon/lat list.
  assert.equal(ring.length, 2 * (FOOTPRINT_TRAIL_STEPS + 1) * 2);
  for (let i = 0; i < ring.length; i += 2) {
    assert.ok(Math.abs(ring[i + 1]) <= 90, `lat ${ring[i + 1]}`);
    assert.ok(Number.isFinite(ring[i]), `lon ${ring[i]}`);
  }
  // The strip is about as wide as the swath: the first left-edge point and
  // the last right-edge point (the same sample's two edges) sit ~3060 km apart.
  const toRad = (d) => (d * Math.PI) / 180;
  const [lonL, latL] = [ring[0], ring[1]];
  const [lonR, latR] = [ring[ring.length - 2], ring[ring.length - 1]];
  const c =
    Math.sin(toRad(latL)) * Math.sin(toRad(latR)) +
    Math.cos(toRad(latL)) * Math.cos(toRad(latR)) * Math.cos(toRad(lonR - lonL));
  const widthKm = (Math.acos(Math.min(1, Math.max(-1, c))) * 6371.0088);
  assert.ok(Math.abs(widthKm - 3060) < 60, `width ${widthKm} km`);
  // Longitudes never jump the long way round the antimeridian.
  for (let i = 2; i < ring.length; i += 2)
    assert.ok(Math.abs(ring[i] - ring[i - 2]) < 180, `jump at ${i}`);
});

test('following an imaging satellite draws its footprint; clearing removes it', () => {
  const { layer, added, removed, viewer } = buildLayer();
  const footprint = layer._footprintForTest();
  layer._seedCatalogForTest([
    { norad: 43013, name: 'NOAA 20', satrec: NOAA20, group: 'weather' },
    { norad: 60133, name: 'GOES 19', satrec: GOES19, group: 'geo' },
    { norad: 25544, name: 'ISS (ZARYA)', satrec: ISS, group: 'stations' },
  ]);
  footprintWithViewer(layer, viewer);

  footprint.follow(43013);
  assert.equal(added.length, 1, 'one strip for a polar imager');
  assert.ok(added[0].polygon, 'a polar imager gets a polygon strip');

  footprint.follow(43013);
  assert.equal(added.length, 1, 'following the same satellite again is a no-op');

  footprint.follow(60133);
  assert.equal(removed.length, 1, 'switching satellites removes the strip');
  assert.equal(added.length, 2);
  assert.ok(added[1].ellipse, 'a geostationary imager gets a disk');
  assert.equal(added[1].ellipse.semiMajorAxis, FOOTPRINT_DISK_RADIUS_M);

  footprint.follow(25544);
  assert.equal(removed.length, 2);
  assert.equal(added.length, 2, 'the station carries no imager: no footprint');

  footprint.follow(43013);
  assert.equal(added.length, 3);
  footprint.remove();
  assert.equal(removed.length, 3);
  footprint.remove();
  assert.equal(removed.length, 3, 'remove is idempotent');
});

test('the strip is rebuilt on the one-second beat, not every frame', () => {
  const { layer, viewer } = buildLayer();
  const footprint = layer._footprintForTest();
  layer._seedCatalogForTest([
    { norad: 43013, name: 'NOAA 20', satrec: NOAA20, group: 'weather' },
  ]);
  footprintWithViewer(layer, viewer);
  footprint.follow(43013);
  const state = layer._layerStateForTest();
  const first = state._footprintRing;
  const at = state._footprintUpdatedAt;
  footprint.tick(at + 200);
  assert.equal(state._footprintRing, first, 'no rebuild inside the beat');
  footprint.tick(at + 1000);
  assert.notEqual(state._footprintRing, first, 'rebuilt once the beat elapses');
  assert.equal(state._footprintUpdatedAt, at + 1000);
});

/** Hand the layer state a viewer double; the footprint reads it from there. */
function footprintWithViewer(layer, viewer) {
  layer._layerStateForTest()._viewer = viewer;
}

/** A viewer double with a real entity collection, for the tracking path. */
function trackingViewer() {
  return {
    entities: new Cesium.EntityCollection(),
    trackedEntity: undefined,
    scene: {
      frameState: { frameNumber: 1 },
      primitives: { add: (p) => p, remove() {} },
    },
  };
}

function seedForTracking(layer, viewer, rows) {
  const state = layer._layerStateForTest();
  state._viewer = viewer;
  state._catalog = new Map(rows.map((row) => [row.norad, row]));
  state._points = new Map(
    rows.map((row) => [
      row.norad,
      {
        position: Cesium.Cartesian3.fromDegrees(0, 0, 1),
        show: true,
        pixelSize: 7,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
        disableDepthTestDistance: 0,
      },
    ]),
  );
  state._orbitPaths = new Map();
  state._pointCollection = { show: true, add: (o) => o, remove() {} };
  state._overlayHost = { setEntries() {}, setVisible() {}, clearSource() {} };
  state._enabled = true;
  state._params = { catalog: 'core', showPoints: true, showOrbits: true };
  return state;
}

test('a geostationary imager is framed from straight out, in ENU; a polar one keeps the along-track view', () => {
  // The default satellite framing follows the dot along its velocity, which
  // for a parked imager looks along the belt at a dot against black. The
  // whole point of following GOES is the disk it images, so its camera sits
  // out past the satellite looking back through it, in a frame whose "up"
  // is away from that disk.
  // The tracking path talks to the real focus, readout and context owners.
  const layer = createSatellitesLayer({
    source: { readGroup() {} },
    services: {
      picking,
      focus,
      readout,
      overlays,
      context,
      render,
      layerState: layerStateService,
    },
  });
  const viewer = trackingViewer();
  seedForTracking(layer, viewer, [
    { norad: 43013, name: 'NOAA 20', satrec: NOAA20, group: 'weather' },
    { norad: 60133, name: 'GOES 19', satrec: GOES19, group: 'geo' },
  ]);
  layer.trackSatellite(60133);
  const geo = viewer.trackedEntity;
  assert.ok(geo, 'GOES-19 is tracked');
  assert.deepEqual(geo.viewFrom.getValue(), TRACK_VIEW_FROM_GEO_IMAGER);
  assert.equal(geo.trackingReferenceFrame, TRACK_VIEW_FROM_GEO_IMAGER_FRAME);
  assert.equal(
    viewer.entities.values.filter((e) => e.ellipse).length,
    1,
    'its disk is under it',
  );

  layer.trackSatellite(43013);
  const polar = viewer.trackedEntity;
  assert.ok(polar && polar !== geo);
  assert.notDeepEqual(polar.viewFrom.getValue(), TRACK_VIEW_FROM_GEO_IMAGER);
  assert.notEqual(polar.trackingReferenceFrame, TRACK_VIEW_FROM_GEO_IMAGER_FRAME);
  assert.equal(viewer.entities.values.filter((e) => e.ellipse).length, 0);
  assert.equal(viewer.entities.values.filter((e) => e.polygon).length, 1);

  layer.stopTracking();
  assert.equal(viewer.entities.values.filter((e) => e.polygon).length, 0);
});

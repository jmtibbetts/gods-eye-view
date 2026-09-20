#!/usr/bin/env node
/**
 * capture-readme-shots — take the README screenshots for the layers and panels
 * added to this fork, against a running dev server.
 *
 * Every shot is scripted rather than hand-captured so it can be retaken when
 * the UI moves: the camera, the enabled layers and the open panels are all set
 * explicitly, and unrelated layers are switched off first so each image shows
 * one idea. Live-data shots depend on what the feeds are reporting the day they
 * run, so a quiet weather day yields a quiet picture — that is honest, and
 * rerunning on an active day is the fix.
 *
 * Usage: node scripts/capture-readme-shots.mjs [--url http://localhost:4173] [--only storm-and-air]
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv;
const arg = (name, fallback) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const url = arg('--url', 'http://localhost:4173');
const only = arg('--only', null);
const outDir = fileURLToPath(new URL('../docs/media/', import.meta.url));
mkdirSync(outDir, { recursive: true });

/** Panels that must be shut before a shot so the globe is unobstructed. */
const ALL_PANELS = [
  'data-panel',
  'global-context-panel',
  'monitor-panel',
  'watchlist-panel',
  'vessel-watch-panel',
  'timeline-panel',
  'imagery-panel',
];

const SHOTS = [
  {
    name: '20-storm-and-air',
    caption:
      'STORM + AIR: NEXRAD radar under live flights with active NWS warnings',
    layers: ['imagery-radar', 'flights', 'weather-alerts'],
    view: { lon: -95, lat: 38.5, height: 5_200_000 },
    settle: 16_000,
  },
  {
    name: '21-storm-reports',
    caption:
      'SPC storm reports: preliminary tornado, wind and hail over a rolling two days',
    layers: ['storm-reports'],
    view: { lon: -93, lat: 38, height: 5_000_000 },
    settle: 12_000,
  },
  {
    name: '22-volcano-alerts',
    caption: 'USGS volcano alerts across the North Pacific',
    layers: ['volcanoes'],
    view: { lon: -168, lat: 38, height: 9_000_000 },
    settle: 12_000,
  },
  {
    name: '23-timeline-archive',
    caption: 'TIMELINE scrubbing VIIRS true-colour back through the archive',
    layers: ['imagery-viirs'],
    view: { lon: -60, lat: 20, height: 14_000_000 },
    panels: ['global-context-panel', 'timeline-panel'],
    scrubDays: 6,
    settle: 22_000,
  },
  {
    name: '24-context-panels',
    caption:
      'MONITOR, WATCHLIST, VESSEL WATCH and TIMELINE in the Context rail',
    layers: ['flights', 'ais-live-vessels'],
    view: { lon: -40, lat: 35, height: 9_000_000 },
    // All four expanded overflow the rail, so leave three as their header
    // chips — which is what shows their live state — and open TIMELINE to
    // give the shot one panel's worth of detail.
    panels: ['global-context-panel', 'timeline-panel'],
    settle: 18_000,
    clip: '#right-context-rail',
    hideSections: [
      'inspect-panel',
      'radio-panel',
      'scanner-panel',
      'sdr-panel',
      'atc-panel',
    ],
  },
  {
    name: '26-imagery-sensors',
    caption:
      'The IMAGERY panel: 24 NASA GIBS sensors grouped by what they reveal',
    layers: ['imagery-goes'],
    view: { lon: -75, lat: 20, height: 16_000_000 },
    panels: ['global-context-panel', 'imagery-panel'],
    // The panel sits near the bottom of a rail that is taller than the
    // viewport, so hide everything above it — otherwise the capture is of
    // whatever the fold happens to cut through. Each hidden panel has its own
    // shot elsewhere in the README.
    settle: 20_000,
    clip: '#imagery-panel',
    clipWithin: '#right-context-rail',
    hideSections: [
      'inspect-panel',
      'radio-panel',
      'scanner-panel',
      'sdr-panel',
      'atc-panel',
      'monitor-panel',
      'watchlist-panel',
      'vessel-watch-panel',
      'timeline-panel',
    ],
  },
  {
    name: '27-goes-geocolor',
    caption:
      'GOES-East GeoColor over the Americas beside the geostationary sensor list',
    layers: ['imagery-goes'],
    view: { lon: -75, lat: 20, height: 16_000_000 },
    // Deliberately keeps the panel open: the globe shows what one sensor
    // looks like and the rail shows what else it could have been, which is
    // the whole point of the feature in a single frame.
    panels: ['global-context-panel', 'imagery-panel'],
    // The rail does not scroll to an expanded panel, so the sections above
    // IMAGERY are hidden to lift it into frame. Each has its own capture.
    hideSections: [
      'inspect-panel',
      'radio-panel',
      'scanner-panel',
      'sdr-panel',
      'atc-panel',
      'monitor-panel',
      'watchlist-panel',
      'vessel-watch-panel',
      'timeline-panel',
    ],
    settle: 24_000,
  },
  {
    name: '25-layer-combinations',
    caption: 'One-press layer combinations above the layer groups',
    layers: [],
    view: { lon: -98, lat: 39, height: 7_000_000 },
    panels: ['data-panel'],
    settle: 6_000,
    clip: '#data-panel',
  },
  {
    name: '28-inspect-aircraft',
    caption:
      'INSPECT: a tracked aircraft with its controller frequency and LISTEN, FOLLOW and PIN beside it',
    layers: ['flights'],
    view: { lon: -97.7, lat: 30.2, height: 250_000 },
    panels: ['global-context-panel', 'inspect-panel'],
    // The highest airborne contact in view: at cruise the controller is a
    // Center sector, which is the case that used to be three panels away.
    trackHighest: 'flights',
    settle: 14_000,
    clip: '[data-context-group="inspect"]',
    clipWithin: '#right-context-rail',
  },
  {
    name: '29-data-layer-groups',
    caption:
      'DATA LAYERS grouped by the part of the world a row draws, with the filter box and PANEL › links',
    layers: ['flights', 'satellites'],
    view: { lon: -98, lat: 39, height: 7_000_000 },
    panels: ['data-panel'],
    settle: 8_000,
    clip: '#data-panel',
  },
];

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1600,1000',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.warn('[page error]', error.message));
  // The first-run chooser covers the globe, and it is durable state rather than
  // a transient dialog, so suppress it the way the app itself does and reload.
  await page.evaluateOnNewDocument((key) => {
    try {
      window.localStorage.setItem(key, 'suppressed');
    } catch {
      /* private mode still gets the dialog; the reload below retries */
    }
  }, 'gev:first-run-mission:v1');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, {
    timeout: 120_000,
  });
  await new Promise((r) => setTimeout(r, 2000));
  const dialogGone = await page.evaluate(
    () => !document.querySelector('#first-run-mission, .first-run-mission'),
  );
  if (!dialogGone) console.warn('[warn] first-run dialog still present');

  // The detection overlay boxes every contact on screen, which is the right
  // default for operating the globe and the wrong one for a still: at CONUS
  // scale it covers the very radar and alert polygons these shots exist to
  // show. Turn it off once, for every shot.
  await page.evaluate(() => {
    const toggle = document.getElementById('detection-toggle');
    if (toggle?.getAttribute('aria-pressed') === 'true') toggle.click();
  });
  await new Promise((r) => setTimeout(r, 1200));

  for (const shot of SHOTS) {
    if (only && shot.name !== only) continue;
    process.stdout.write(`capturing ${shot.name} ... `);

    // One idea per image: everything else off.
    await page.evaluate(async (wanted) => {
      const gev = window.__godsEyeView;
      gev.viewer.camera.cancelFlight();
      for (const [id, entry] of gev.dataManager.layers) {
        const shouldBeOn = wanted.includes(id);
        if (entry.enabled === shouldBeOn) continue;
        try {
          await gev.dataManager.setEnabled(id, shouldBeOn, { origin: 'user' });
        } catch {
          /* a layer refusing must not abort the capture run */
        }
      }
    }, shot.layers);

    // Collapse everything this shot is not featuring. Panel state is durable in
    // localStorage, so a panel left open by an earlier shot stays open into the
    // next one unless it is explicitly closed here.
    await page.evaluate(
      (toClose) => {
        for (const id of toClose) {
          const section = document.getElementById(id);
          const button = document.querySelector(
            `.panel-collapse-btn[data-collapse-target="${id}"]`,
          );
          if (section && button && !section.classList.contains('collapsed'))
            button.click();
        }
      },
      ALL_PANELS.filter((id) => !(shot.panels || []).includes(id)),
    );

    await page.evaluate((panels) => {
      for (const id of panels) {
        const section = document.getElementById(id);
        const button = document.querySelector(
          `.panel-collapse-btn[data-collapse-target="${id}"]`,
        );
        if (section?.classList.contains('collapsed') && button) button.click();
      }
    }, shot.panels || []);

    await page.evaluate((v) => {
      const viewer = window.__godsEyeView.viewer;
      const ell = viewer.scene.globe.ellipsoid;
      viewer.camera.setView({
        destination: ell.cartographicToCartesian({
          longitude: (v.lon * Math.PI) / 180,
          latitude: (v.lat * Math.PI) / 180,
          height: v.height,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, shot.view);

    if (shot.scrubDays) {
      await page.evaluate((days) => {
        const slider = document.getElementById('timeline-slider');
        if (!slider) return;
        const max = Number(slider.max) || 13;
        slider.value = String(Math.max(0, max - days));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }, shot.scrubDays);
    }

    // The rail is taller than the viewport and does not scroll to an expanded
    // panel, so a shot of one near its bottom would be cropped away or miss it
    // entirely. Hide the sections this shot is not about — each is documented
    // by its own capture — rather than scrolling, which the rail does not do
    // predictably. Done before the settle so the layout is final, and outside
    // the clip branch so full-frame shots can lift a panel into view too.
    await page.evaluate((hide) => {
      // Un-hide first: display:none set for an earlier shot would otherwise
      // persist into every shot after it, silently emptying their rails.
      for (const section of document.querySelectorAll('[data-panel-id]'))
        section.style.display = '';
      for (const id of hide) {
        const section = document.getElementById(id);
        if (section) section.style.display = 'none';
      }
    }, shot.hideSections || []);

    await new Promise((r) => setTimeout(r, shot.settle));

    // Track the highest airborne contact of a layer so the shot shows a
    // selection rather than an empty INSPECT card. Whatever is overhead the
    // day this runs is what the picture shows.
    if (shot.trackHighest) {
      const tracked = await page.evaluate((layerId) => {
        const gev = window.__godsEyeView;
        const module = gev.dataManager.layers.get(layerId)?.module;
        const records = module?.getAnalystRecords?.(2000) || [];
        const airborne = records
          .filter((r) => Number.isFinite(r.lat) && !r.onGround)
          .sort((a, b) => (b.altitudeM || 0) - (a.altitudeM || 0));
        const pick = airborne[0];
        if (!pick) return null;
        return module.trackById?.(pick.icao24 || pick.id)
          ? pick.callsign
          : null;
      }, shot.trackHighest);
      if (!tracked) console.warn(`no airborne ${shot.trackHighest} to track`);
      await new Promise((r) => setTimeout(r, 5_000));
    }

    const path = `${outDir}${shot.name}.png`;
    if (shot.clip) {
      const rect = await page.evaluate(
        (selector, within) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const r = node.getBoundingClientRect();
          let bottom = r.bottom;
          // A panel taller than its scrolling rail reports a box that runs
          // past what is actually painted, and the capture then trails off
          // into whatever sits below the rail. Clamp to the scroll container.
          if (within) {
            const box = document.querySelector(within);
            if (box)
              bottom = Math.min(bottom, box.getBoundingClientRect().bottom);
          }
          return { x: r.x, y: r.y, width: r.width, height: bottom - r.y };
        },
        shot.clip,
        shot.clipWithin || null,
      );
      if (!rect) throw new Error(`clip target ${shot.clip} not found`);
      await new Promise((r) => setTimeout(r, 1200));
      const view = page.viewport();
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      await page.screenshot({
        path,
        clip: {
          x,
          y,
          width: Math.min(Math.ceil(rect.width), view.width - x),
          height: Math.min(Math.ceil(rect.height), view.height - y),
        },
      });
    } else {
      await page.screenshot({ path });
    }
    console.log('ok');
  }
} finally {
  await browser.close();
}
process.exit(0);

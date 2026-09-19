import { EUMETVIEW_WMS, GIBS_BASE, gibsTileUrl, isWms } from './catalog.js';

/**
 * Frame loops for the rolling geostationary products.
 *
 * A geostationary imager publishes a new full disk every ten or fifteen
 * minutes, and GIBS and EUMETView both keep the recent frames addressable by
 * instant. Twelve of them in a row is the weather moving — the thing the
 * satellite is actually for — so a loop is offered wherever a product says
 * how often its frames come.
 *
 * Frames are found, not assumed. GIBS answers DescribeDomains with the
 * instants it actually holds, and both services are probed with one tiny
 * request per candidate frame before anything is drawn, because a frame that
 * is missing (a maintenance gap, a late scan) would otherwise play as a
 * blank globe and read as the feed breaking.
 */

/** How many frames a loop holds; the window is this many steps back. */
export const LOOP_FRAMES = 12;

/** Minutes between frames for a product, or null when it cannot loop. */
export function loopStepMinutes(product) {
  const step = Number(product?.loopStepMinutes);
  return product?.cadence === 'rolling' && Number.isFinite(step) && step > 0
    ? step
    : null;
}

/** The [from, to] window a loop covers, ending now. */
export function loopWindow(product, nowMs = Date.now()) {
  const step = loopStepMinutes(product);
  if (!step) return null;
  const toMs = Math.floor(nowMs / 60_000) * 60_000;
  return {
    fromMs: toMs - LOOP_FRAMES * step * 60_000,
    toMs,
    stepMinutes: step,
  };
}

/** "the last 2 h" / "the last 36 h" — what the window amounts to. */
export function loopWindowText(product) {
  const step = loopStepMinutes(product);
  if (!step) return '';
  const minutes = LOOP_FRAMES * step;
  return minutes % 60 === 0
    ? `the last ${minutes / 60} h`
    : `the last ${minutes} min`;
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Instants at every step inside the window, aligned to the step. */
export function stepInstants(fromMs, toMs, stepMinutes) {
  const stepMs = stepMinutes * 60_000;
  const out = [];
  for (let t = Math.floor(fromMs / stepMs) * stepMs; t <= toMs; t += stepMs)
    if (t >= fromMs) out.push(iso(t));
  return out;
}

/** GIBS's WMTS DescribeDomains for a product over a window. */
export function describeDomainsUrl(product, fromMs, toMs) {
  const url = new URL(`${GIBS_BASE}/wmts.cgi`);
  url.searchParams.set('SERVICE', 'WMTS');
  url.searchParams.set('VERSION', '1.0.0');
  url.searchParams.set('REQUEST', 'DescribeDomains');
  url.searchParams.set('LAYER', product.gibsId);
  url.searchParams.set('TILEMATRIXSET', product.matrixSet);
  url.searchParams.set('TIME', `${iso(fromMs)}/${iso(toMs)}`);
  return url.href;
}

const PERIOD = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function periodMs(text) {
  const m = PERIOD.exec(String(text || ''));
  if (!m) return null;
  const [, d, h, min, s] = m.map((x) => Number(x || 0));
  const ms = ((d * 24 + h) * 60 + min) * 60_000 + s * 1000;
  return ms > 0 ? ms : null;
}

/**
 * Every instant a DescribeDomains response says exists inside the window.
 * The domain is a comma-separated list of `start/end/period` ranges or bare
 * instants; a range is expanded step by step.
 * @param {string} xml
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {string[]} Sorted, unique ISO instants.
 */
export function domainInstants(xml, fromMs, toMs) {
  const m = /<Domain>([^<]*)<\/Domain>/.exec(String(xml || ''));
  if (!m) return [];
  const found = new Set();
  for (const part of m[1].split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const [start, end, period] = piece.split('/');
    const startMs = Date.parse(start);
    if (!Number.isFinite(startMs)) continue;
    const endMs = end ? Date.parse(end) : startMs;
    const step = period ? periodMs(period) : null;
    if (!Number.isFinite(endMs) || !step) {
      if (startMs >= fromMs && startMs <= toMs) found.add(iso(startMs));
      continue;
    }
    // A day-only start ("2026-09-19") means midnight; step from there.
    for (let t = startMs; t <= endMs; t += step)
      if (t >= fromMs && t <= toMs) found.add(iso(t));
  }
  return [...found].sort();
}

/**
 * One small request that answers "does this frame exist": the world tile
 * for GIBS, a 64-pixel GetMap for a WMS product.
 */
export function frameProbeUrl(product, instant) {
  if (isWms(product)) {
    const url = new URL(product.wmsUrl || EUMETVIEW_WMS);
    url.searchParams.set('SERVICE', 'WMS');
    url.searchParams.set('VERSION', '1.3.0');
    url.searchParams.set('REQUEST', 'GetMap');
    url.searchParams.set('LAYERS', product.wmsLayer);
    url.searchParams.set('CRS', 'EPSG:4326');
    url.searchParams.set('BBOX', '-90,-180,90,180');
    url.searchParams.set('WIDTH', '64');
    url.searchParams.set('HEIGHT', '32');
    url.searchParams.set('FORMAT', 'image/png');
    url.searchParams.set('TRANSPARENT', 'true');
    url.searchParams.set('TIME', instant);
    return url.href;
  }
  return `${GIBS_BASE}/${product.gibsId}/default/${instant}/${product.matrixSet}/0/0/0.${product.ext}`;
}

/** The provider config for one frame, in the shape resolveConfig() returns. */
export function frameConfig(product, instant, { credit } = {}) {
  if (isWms(product)) {
    return {
      wms: {
        url: product.wmsUrl || EUMETVIEW_WMS,
        layers: product.wmsLayer,
        credit,
        maximumLevel: product.maximumLevel,
        parameters: {
          format: 'image/png',
          transparent: true,
          TIME: instant,
        },
      },
    };
  }
  return {
    url: gibsTileUrl(product, instant),
    maximumLevel: product.maximumLevel,
    credit,
  };
}

/**
 * Which candidate frames actually answer. Probes run together; a probe that
 * throws or is refused drops its frame, never the loop.
 * @param {object} product
 * @param {string[]} instants
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string[]>}
 */
export async function probeFrames(product, instants, fetchImpl) {
  const results = await Promise.all(
    instants.map(async (instant) => {
      try {
        const response = await fetchImpl(frameProbeUrl(product, instant), {
          cache: 'force-cache',
        });
        return response?.ok ? instant : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}

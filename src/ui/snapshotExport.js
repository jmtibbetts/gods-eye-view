/**
 * Snapshot export — capture the current globe view (Cesium scene plus the
 * world-overlay labels drawn on top) as a PNG with a caption and a footer
 * stamp, for shareable situational reports. Self-contained: reads the two
 * canvases already on the page and downloads a file.
 *
 * The main viewer is created with preserveDrawingBuffer, so the scene canvas
 * is readable here.
 */

/** Two footer lines from the view metadata. Pure, so it is unit tested. */
export function snapshotStamp({
  caption = '',
  lat = null,
  lon = null,
  place = '',
  date = new Date(),
} = {}) {
  const coord =
    Number.isFinite(lat) && Number.isFinite(lon)
      ? `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`
      : '';
  const stampDate = date instanceof Date ? date : new Date(date);
  const when = `${stampDate.toISOString().slice(0, 16).replace('T', ' ')}Z`;
  const title = String(caption || place || 'GOD’S EYE VIEW').trim();
  const meta = [coord, when, 'GOD’S EYE VIEW'].filter(Boolean).join('  ·  ');
  return { title, meta };
}

/** A filesystem-safe filename for the snapshot. */
export function snapshotFilename(caption = '', date = new Date()) {
  const slug = String(caption || 'view')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stampDate = date instanceof Date ? date : new Date(date);
  const ts = stampDate.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `gods-eye-view-${slug || 'view'}-${ts}.png`;
}

/**
 * Composite the scene and overlay canvases onto a target 2D context and draw
 * the caption/footer. Exposed for direct use and testing with a fake context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{sceneCanvas:any, overlayCanvas:any, width:number, height:number, stamp:{title:string, meta:string}}} options
 */
export function drawSnapshot(
  ctx,
  { sceneCanvas, overlayCanvas, width, height, stamp },
) {
  ctx.fillStyle = '#02060a';
  ctx.fillRect(0, 0, width, height);
  if (sceneCanvas) ctx.drawImage(sceneCanvas, 0, 0, width, height);
  if (overlayCanvas) ctx.drawImage(overlayCanvas, 0, 0, width, height);
  const barH = Math.max(54, Math.round(height * 0.075));
  const grad = ctx.createLinearGradient(0, height - barH, 0, height);
  grad.addColorStop(0, 'rgba(2,10,16,0)');
  grad.addColorStop(0.35, 'rgba(2,10,16,0.82)');
  grad.addColorStop(1, 'rgba(2,10,16,0.95)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, height - barH, width, barH);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e8feff';
  ctx.font = `600 ${Math.round(barH * 0.34)}px "JetBrains Mono", monospace`;
  ctx.fillText(stamp.title, 22, height - barH + barH * 0.44, width - 44);
  ctx.fillStyle = 'rgba(114,220,230,0.9)';
  ctx.font = `${Math.round(barH * 0.24)}px "JetBrains Mono", monospace`;
  ctx.fillText(stamp.meta, 22, height - barH + barH * 0.82, width - 44);
}

/**
 * Capture and download a PNG of the current view.
 * @param {object} options
 * @param {any} options.viewer Cesium viewer.
 * @param {HTMLCanvasElement|null} [options.overlayCanvas] The world-overlay canvas.
 * @param {{lat?:number, lon?:number}|null} [options.center] View centre for the stamp.
 * @param {string} [options.caption]
 * @param {string} [options.place]
 * @param {Document} [options.doc]
 * @returns {Promise<boolean>} True when a download was triggered.
 */
export async function captureSnapshot({
  viewer,
  overlayCanvas = null,
  center = null,
  caption = '',
  place = '',
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  const sceneCanvas = viewer?.scene?.canvas || viewer?.canvas;
  if (!sceneCanvas || !doc) return false;
  try {
    viewer.scene?.render?.();
  } catch {
    /* a render failure still lets us read the last buffer */
  }
  const width = sceneCanvas.width;
  const height = sceneCanvas.height;
  const target = doc.createElement('canvas');
  target.width = width;
  target.height = height;
  const ctx = target.getContext('2d');
  if (!ctx) return false;
  const stamp = snapshotStamp({
    caption,
    place,
    lat: center?.lat ?? null,
    lon: center?.lon ?? null,
  });
  drawSnapshot(ctx, { sceneCanvas, overlayCanvas, width, height, stamp });
  const blob = await new Promise((resolve) =>
    target.toBlob((b) => resolve(b), 'image/png'),
  );
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = snapshotFilename(caption || place);
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

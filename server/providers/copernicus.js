/**
 * Copernicus Data Space (Sentinel Hub) proxy — Sentinel-2 imagery at 10 m.
 *
 * This exists for one reason: the client secret must never reach the browser.
 * Sentinel Hub authenticates with an OAuth2 `client_credentials` grant, and a
 * browser-side exchange would mean shipping the secret to every visitor. So
 * the credentials stay in the server process, this trades them for a
 * short-lived bearer token, and the page only ever sees rendered tiles.
 *
 * Everything else in the imagery catalog is keyless. This is the one product
 * behind a key, and it is optional: without credentials the route reports
 * `no_key` and the catalog simply does not offer the sensor, rather than
 * offering it and failing when clicked.
 *
 * Routes:
 *   GET /api/copernicus/status → {hasKey, tokenOk, expiresInSec}
 *   GET /api/copernicus/wms?…  → WMS GetMap passthrough, token attached
 *
 * Token handling mirrors the OpenSky provider in this repo: cached with a
 * safety margin, and concurrent callers share one in-flight refresh so a burst
 * of tile requests cannot stampede the token endpoint, which rate-limits with
 * HTTP 429.
 */

const TOKEN_URL =
  'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
/**
 * The OGC endpoint is per-configuration: Sentinel Hub requires a
 * "configuration instance", created in the dashboard's Configuration Utility,
 * and its id forms the last path segment. Accounts ship with a pre-made
 * "Simple WMS Instance" that works for this. The OAuth token alone is not
 * enough for OGC — that is the Process API, which is POST-per-tile and so does
 * not fit an imagery provider.
 */
const WMS_BASE = 'https://sh.dataspace.copernicus.eu/ogc/wms';

/** Refresh this long before the token actually expires. */
const REFRESH_MARGIN_MS = 60_000;
/** Upstream tile requests are abandoned after this. */
const TILE_TIMEOUT_MS = 20_000;
/**
 * Sentinel Hub's rendering ceiling for Sentinel-2: "Rendering is available up
 * to 200 m/px." A coarser request is not refused with an error status — it is
 * answered with an IMAGE whose pixels spell the error out, and a map engine
 * paints that as if it were data. The catalog keeps the client from asking
 * (see zoomFloorFor in src/layers/imageryOverlays/catalog.js); this is the
 * same limit enforced where the request actually leaves, so nothing that
 * slips past — an older client, a hand-typed URL — ever spends quota on a
 * tile that can only come back as a paragraph of red text.
 */
export const MAX_METERS_PER_PIXEL = 200;
/** Metres per degree of latitude — the axis that does not shrink. */
const METERS_PER_DEGREE = (2 * Math.PI * 6378137) / 360;
/** A 1×1 fully transparent PNG: the honest answer to a tile that cannot exist. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Params we forward to Sentinel Hub. Anything else is dropped. */
const ALLOWED_PARAMS = new Set([
  'service',
  'request',
  'version',
  'layers',
  'styles',
  'format',
  'transparent',
  'crs',
  'srs',
  'bbox',
  'width',
  'height',
  'time',
  'maxcc',
  'showlogo',
  'bgcolor',
  'priority',
]);

/**
 * Coarsest pixel size a GetMap asks for, in metres per pixel, measured on the
 * geographic axes as WMS states them. A bounding box is the same number of
 * degrees along both axes for a square tile, and a degree of latitude is
 * always ~111 km, so taking the larger axis gives the size the service's limit
 * binds on regardless of axis order or latitude. Returns null when the request
 * does not carry the numbers.
 * @param {URLSearchParams} query GetMap parameters (any case).
 * @returns {number|null}
 */
export function requestMetersPerPixel(query) {
  const bbox = String(query.get('bbox') || query.get('BBOX') || '')
    .split(',')
    .map(Number);
  const width = Number(query.get('width') || query.get('WIDTH'));
  const height = Number(query.get('height') || query.get('HEIGHT'));
  if (
    bbox.length !== 4 ||
    bbox.some((n) => !Number.isFinite(n)) ||
    !(width > 0) ||
    !(height > 0)
  )
    return null;
  const [a, b, c, d] = bbox;
  return (
    Math.max(Math.abs(c - a) / width, Math.abs(d - b) / height) *
    METERS_PER_DEGREE
  );
}

export function copernicusProxy() {
  let token = null;
  let expiry = 0;
  /** @type {?Promise<?string>} */
  let inflight = null;
  let warned = false;

  function credentials() {
    const id = process.env.COPERNICUS_CLIENT_ID;
    const secret = process.env.COPERNICUS_CLIENT_SECRET;
    return id && secret ? { id, secret } : null;
  }

  /** The OGC configuration instance, without which WMS cannot be addressed. */
  function instanceId() {
    return String(process.env.COPERNICUS_INSTANCE_ID || '').trim() || null;
  }

  /**
   * A valid bearer token, or null when unconfigured or the exchange failed.
   * Never throws: a missing token must degrade the layer, not the dev server.
   */
  async function getToken() {
    const now = Date.now();
    if (token && now < expiry - REFRESH_MARGIN_MS) return token;
    if (inflight) return inflight;
    const creds = credentials();
    if (!creds) return null;

    inflight = (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: creds.id,
          client_secret: creds.secret,
        });
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const data = await res.json().catch(() => null);
        const accessToken = data?.access_token;
        if (!res.ok || !accessToken) {
          if (!warned) {
            warned = true;
            const detail =
              data?.error_description || data?.error || `HTTP ${res.status}`;
            // Say which credential is being rejected, not just that auth
            // failed — the usual cause is a secret copied with whitespace.
            console.warn(
              `[Copernicus] token exchange refused: ${detail}. Check COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET in .env`,
            );
          }
          token = null;
          expiry = 0;
          return null;
        }
        warned = false;
        token = accessToken;
        expiry = Date.now() + Number(data.expires_in || 600) * 1000;
        return token;
      } catch (error) {
        if (!warned) {
          warned = true;
          console.warn(`[Copernicus] token exchange failed: ${error?.message}`);
        }
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /**
   * Rebuild the query from allow-listed params only.
   *
   * Also substitutes the configured layer name. Sentinel Hub layer names are
   * defined per configuration instance, so the catalog can only ship a
   * best-guess default; COPERNICUS_S2_LAYER lets an account whose instance
   * names it differently point at the right one without editing code.
   * /api/copernicus/layers lists what the instance actually has.
   */
  function safeQuery(rawUrl) {
    const incoming = new URL(rawUrl, 'http://localhost');
    const out = new URLSearchParams();
    const override = String(process.env.COPERNICUS_S2_LAYER || '').trim();
    for (const [key, value] of incoming.searchParams) {
      if (!ALLOWED_PARAMS.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === 'layers' && override) out.set(key, override);
      else out.set(key, value);
    }
    return out;
  }

  // One installer, mounted on both hooks: a provider that only registered on
  // the dev server would 404 in a built preview, which is where this actually
  // gets used. Mirrors the other providers in this directory.
  function installMiddleware(server) {
    server.middlewares.use('/api/copernicus/status', async (req, res) => {
      const creds = credentials();
      const active = creds ? await getToken() : null;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          hasKey: Boolean(creds),
          hasInstance: Boolean(instanceId()),
          // The sensor is only offered when BOTH are present; an instance
          // without credentials, or the reverse, cannot fetch a tile.
          ready: Boolean(creds && instanceId() && active),
          tokenOk: Boolean(active),
          expiresInSec: active
            ? Math.max(0, Math.round((expiry - Date.now()) / 1000))
            : 0,
        }),
      );
    });

    // The account's own configuration instances, so the id does not have to be
    // hunted for in a dashboard. Sentinel Hub exposes them to the same
    // credentials that fetch tiles, and the ids are needed in .env anyway.
    server.middlewares.use('/api/copernicus/instances', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const bearer = await getToken();
      if (!bearer) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'no_key', instances: [] }));
        return;
      }
      try {
        const upstream = await fetch(
          'https://sh.dataspace.copernicus.eu/configuration/v1/wms/instances',
          { headers: { Authorization: `Bearer ${bearer}` } },
        );
        const body = await upstream.text();
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        const instances = Array.isArray(parsed)
          ? parsed.map((i) => ({ id: i?.id, name: i?.name }))
          : [];
        res.statusCode = upstream.ok ? 200 : upstream.status;
        res.end(
          JSON.stringify(
            upstream.ok
              ? { instances }
              : {
                  error: `HTTP ${upstream.status}`,
                  detail: body.slice(0, 300),
                  instances: [],
                },
          ),
        );
      } catch (error) {
        res.statusCode = 504;
        res.end(JSON.stringify({ error: error?.message, instances: [] }));
      }
    });

    // Which layers THIS account's configuration instance actually offers.
    // Layer names are per-instance, so hardcoding one would be a guess that
    // fails silently as a blank tile. This asks the server instead.
    server.middlewares.use('/api/copernicus/layers', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const instance = instanceId();
      const bearer = await getToken();
      if (!instance || !bearer) {
        res.statusCode = 503;
        res.end(
          JSON.stringify({
            error: instance ? 'no_key' : 'no_instance',
            layers: [],
          }),
        );
        return;
      }
      try {
        const upstream = await fetch(
          `${WMS_BASE}/${encodeURIComponent(instance)}?service=WMS&request=GetCapabilities&version=1.3.0`,
          { headers: { Authorization: `Bearer ${bearer}` } },
        );
        const xml = await upstream.text();
        // Deliberately a regex rather than an XML parser: we want the layer
        // names only, and a capabilities document is large.
        const names = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)]
          .map((m) => m[1])
          .filter((n) => n && n.toLowerCase() !== 'wms');
        res.statusCode = upstream.ok ? 200 : 502;
        res.end(JSON.stringify({ layers: [...new Set(names)] }));
      } catch (error) {
        res.statusCode = 504;
        res.end(JSON.stringify({ error: error?.message, layers: [] }));
      }
    });

    server.middlewares.use('/api/copernicus/wms', async (req, res) => {
      const instance = instanceId();
      if (!instance) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'no_instance',
            hint: 'Set COPERNICUS_INSTANCE_ID in .env — create one in the Sentinel Hub dashboard under Configuration Utility.',
          }),
        );
        return;
      }
      const query = safeQuery(req.url || '');
      const metersPerPixel = requestMetersPerPixel(query);
      if (metersPerPixel !== null && metersPerPixel > MAX_METERS_PER_PIXEL) {
        // Sentinel Hub would answer this with a picture of an error message.
        // A transparent tile is what the map should show there: nothing.
        // Decided before the token exchange: no secret is traded for a tile
        // that is refused here.
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=600');
        res.setHeader('X-GEV-Skipped', 'pixel-size-over-limit');
        res.end(TRANSPARENT_PNG);
        return;
      }
      const bearer = await getToken();
      if (!bearer) {
        res.statusCode = credentials() ? 502 : 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: credentials() ? 'auth_failed' : 'no_key',
            hint: 'Set COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET in .env, then restart the dev server.',
          }),
        );
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TILE_TIMEOUT_MS);
      try {
        const upstream = await fetch(
          `${WMS_BASE}/${encodeURIComponent(instance)}?${query.toString()}`,
          {
            headers: { Authorization: `Bearer ${bearer}` },
            signal: controller.signal,
          },
        );
        const type = upstream.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.statusCode = upstream.status;
        res.setHeader('Content-Type', type);
        // Tiles are immutable for a given TIME, so let the browser keep them.
        if (upstream.ok) res.setHeader('Cache-Control', 'public, max-age=600');
        res.end(buffer);
      } catch (error) {
        res.statusCode = 504;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'upstream_failed',
            detail: error?.name === 'AbortError' ? 'timeout' : error?.message,
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return {
    name: 'gev-copernicus-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
} = {}) {
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    optimizeDeps: {
      // egm96-universal is reached only through a dynamic import in
      // src/data/geoid.js, so a freshly started dev server does not know about
      // it until the first flight is tracked. Vite then discovers it, re-runs
      // dependency optimisation, and answers the in-flight request with 504
      // "Outdated Optimize Dep" while a browser is expected to reload. A
      // headless run does not reload, so `npm run test:track` against a cold
      // server failed on that one request every time — and passed against a
      // long-lived dev server that had already discovered the module. Naming
      // it here pre-bundles it up front, so the cold case behaves like the
      // warm one.
      include: ['egm96-universal'],
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}

/**
 * curate-place-label-anchors — precompute where each polygon's name goes.
 *
 * Continents, countries, oceans, seas and physical regions are outlines with
 * no label point in them. Finding one is a pole-of-inaccessibility search
 * costing about a millisecond a shape, and there are a thousand shapes — two
 * and a half seconds of geometry on a layer that is on by default is a two
 * and a half second stall the moment the app opens.
 *
 * So it is computed here and bundled. The output is derived data: delete it
 * and re-run this, and you get it back.
 *
 * Usage: node scripts/curate-place-label-anchors.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPolygonAnchors } from '../src/layers/placeNames/records.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'src/data/local_data');
const OUT = path.join(DATA, 'natural_earth_places/anchors.json');

const read = async (relative) =>
  JSON.parse(await readFile(path.join(DATA, relative), 'utf8'));

async function main() {
  const sources = {
    countries: 'natural_earth_countries/countries.json',
    regions: 'natural_earth/regions.json',
    marine: 'natural_earth/marine.json',
  };
  const packs = {
    countries: await read(sources.countries),
    regions: await read(sources.regions),
    marine: await read(sources.marine),
  };
  const started = Date.now();
  const features = buildPolygonAnchors(packs);
  const elapsed = Date.now() - started;

  const byTier = {};
  for (const feature of features)
    byTier[feature.tier] = (byTier[feature.tier] || 0) + 1;

  const payload = {
    meta: {
      source: 'derived from the bundled Natural Earth polygon packs',
      inputs: sources,
      curation: {
        script: 'scripts/curate-place-label-anchors.mjs',
        method:
          'pole of inaccessibility (src/data/placeAnchors.js) on each feature’s largest ring',
        rank: 'derived from anchor clearance — how much room the name has',
        counts: byTier,
        computeMs: elapsed,
      },
      license:
        'public domain — https://www.naturalearthdata.com/about/terms-of-use/',
    },
    features,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  console.log(
    `anchors: ${features.length} (${JSON.stringify(byTier)}) in ${elapsed} ms → ${OUT} (${Math.round(bytes / 1024)} KB)`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

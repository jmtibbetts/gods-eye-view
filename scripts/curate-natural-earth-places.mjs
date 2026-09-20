/**
 * curate-natural-earth-places — build the offline populated-places pack.
 *
 * The other Natural Earth packs in this repo were curated by hand and recorded
 * their parameters in a `meta.curation` header. This one records them the same
 * way and is a script as well, because a places pack has a judgement call in it
 * — which places are worth a label — and a judgement call that cannot be re-run
 * is a judgement nobody can check.
 *
 * Source is pinned to the SAME commit as `natural_earth_countries`, so the two
 * packs describe one snapshot of the world rather than two.
 *
 * Usage: node scripts/curate-natural-earth-places.mjs [--input path.geojson]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const DATASET = 'ne_10m_populated_places_simple';
const URL_ = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${COMMIT}/geojson/${DATASET}.geojson`;
const OUT = path.join(
  ROOT,
  'src/data/local_data/natural_earth_places/places.json',
);

/** Coordinates to three decimals — ~110 m, far finer than a city label needs. */
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

/**
 * Natural Earth's own prominence rank, which is what its cartographers use to
 * decide when a place earns a label. Lower is more prominent. We keep it
 * rather than deriving our own from population, because population alone puts
 * a million-person suburb above a national capital.
 */
const rankOf = (p) => {
  const rank = Number(p.scalerank);
  return Number.isFinite(rank) ? rank : 10;
};

/** A national capital, which is labelled before anything else its size. */
const isCapital = (p) => p.adm0cap === 1 || p.featurecla === 'Admin-0 capital';

async function loadSource(inputPath) {
  if (inputPath) return JSON.parse(await readFile(inputPath, 'utf8'));
  const response = await fetch(URL_);
  if (!response.ok)
    throw new Error(
      `${DATASET}: HTTP ${response.status} from the pinned commit`,
    );
  return response.json();
}

async function main() {
  const argv = process.argv.slice(2);
  const inputAt = argv.indexOf('--input');
  const source = await loadSource(inputAt >= 0 ? argv[inputAt + 1] : null);

  const seen = new Set();
  const features = [];
  let dropped = 0;
  for (const feature of source.features || []) {
    const p = feature.properties || {};
    // Research stations and weather masts are not places anyone is looking
    // for on a globe, and a "Historic place" is a label for somewhere that is
    // no longer there.
    if (
      p.featurecla === 'Scientific station' ||
      p.featurecla === 'Meteorological Station' ||
      p.featurecla === 'Historic place'
    ) {
      dropped++;
      continue;
    }
    // The source carries a few names with doubled spaces ("Washington,  D.C.").
    const name = String(p.name || p.nameascii || '')
      .replace(/\s+/g, ' ')
      .trim();
    const [lon, lat] = feature.geometry?.coordinates || [];
    if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      dropped++;
      continue;
    }
    // One name in one country at one spot is one place: the source carries a
    // handful of near-duplicates (alternate capital entries, mostly).
    const key = `${name}|${p.adm0_a3 || ''}|${round3(lon)}|${round3(lat)}`;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    features.push({
      name,
      lon: round3(lon),
      lat: round3(lat),
      rank: rankOf(p),
      ...(isCapital(p) ? { capital: 1 } : {}),
      ...(Number(p.pop_max) > 0 ? { pop: Number(p.pop_max) } : {}),
      ...(p.iso_a2 && p.iso_a2 !== '-99' ? { iso: p.iso_a2 } : {}),
    });
  }

  features.sort((a, b) => a.rank - b.rank || (b.pop || 0) - (a.pop || 0));

  const payload = {
    meta: {
      source: `Natural Earth 10m cultural vectors — ${DATASET}`,
      url: URL_,
      commit: COMMIT,
      curation: {
        script: 'scripts/curate-natural-earth-places.mjs',
        resolution: '10m',
        coordinates: '3 decimals',
        names: 'whitespace collapsed',
        kept: features.length,
        dropped,
        excludedClasses: [
          'Scientific station',
          'Meteorological Station',
          'Historic place',
        ],
        fields:
          'name, lon, lat, rank (Natural Earth scalerank), capital, pop, iso',
        sortedBy: 'rank, then population',
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
    `${DATASET}: kept ${features.length}, dropped ${dropped} → ${OUT} (${Math.round(bytes / 1024)} KB)`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

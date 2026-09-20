# Natural Earth populated-places pack

Offline city and town points, for the place-names layer
(`src/layers/placeNames/`). Every other label tier the globe draws —
continents, countries, oceans and seas, mountain ranges and deserts — comes
from polygon packs already in this repo. Cities are points, and there was no
point data here until this pack.

| File | Source dataset | Features |
|------|----------------|----------|
| `places.json` | `ne_10m_populated_places_simple` | 7,295 places, 203 national capitals |

**Source:** Natural Earth 10m cultural vectors, via the canonical
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
GitHub repo, commit `ca96624a56bd078437bca8184e78163e5039ad19` — the SAME
commit as the country pack, so the two describe one snapshot of the world
rather than two. Exact provenance is in the file's `meta` header.

**License:** public domain
(https://www.naturalearthdata.com/about/terms-of-use/). No attribution legally
required; we credit "Made with Natural Earth" anyway. See DATA_SOURCES.md.

## Why 10m and not 110m

Because the labels are read at every zoom, not just from orbit. The 110m
places file carries 243 cities, which is a globe view and nothing else — fly
into a country and there is nothing left to name. 10m carries 7,295, enough
that a regional view still has towns in it, and Natural Earth's own
`scalerank` says which ones deserve a label first, so the extra rows cost
nothing until you are close enough to want them.

## Why `scalerank` and not population

Because population alone is the wrong ranking for a label. A million-person
suburb outranks a national capital on population and is worth far less on a
map. `scalerank` is Natural Earth's own cartographic prominence — what its
cartographers use to decide when a place earns a label — so the layer inherits
a judgement made by people who do this for a living. Population is kept
alongside it for the readout, not for the ranking.

`capital` is carried separately and beats rank, because a national capital is
what you look for first in a country you do not know.

## What was dropped

47 of the 7,342 source rows:

- **Scientific stations and one meteorological station.** McMurdo is not a
  place someone is scanning Antarctica for; it is a base, and the app has
  layers for installations.
- **Historic places.** A label for somewhere that is no longer there reads as
  an error on a live globe.
- **Near-duplicates.** A handful of alternate capital entries repeat a name at
  the same spot in the same country.

## Curation

Parameters are recorded in `meta.curation`, and unlike the older packs this one
is reproducible:

```
node scripts/curate-natural-earth-places.mjs
```

It fetches the pinned commit directly; `--input <file.geojson>` re-curates from
a local copy instead. Coordinates are rounded to 3 decimals (~110 m, far finer
than a label needs), names have runs of whitespace collapsed (the source has a
few doubled spaces, "Washington,  D.C." among them), and features are sorted by
rank then population so the most prominent places are first in the file.

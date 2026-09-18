# Natural Earth country pack

Offline country polygons keyed by FIPS 10-4, for the conflict-reporting layer
(`src/layers/conflictReports/`). Country-level shading needs country-level
geometry, and this is the only dataset in the project that carries it.

| File | Source dataset | Features |
|------|----------------|----------|
| `countries.json` | `ne_110m_admin_0_countries` | 177 countries, 178 codes |

**Source:** Natural Earth 110m cultural vectors, via the canonical
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
GitHub repo, commit `ca96624a56bd078437bca8184e78163e5039ad19` — exact
provenance is in the file's `meta` header.

**License:** public domain
(https://www.naturalearthdata.com/about/terms-of-use/). No attribution legally
required; we credit "Made with Natural Earth" anyway. See DATA_SOURCES.md.

## Why 110m and not 50m or 10m

Because the data drawn on it is country-resolution. GDELT geocodes a large
share of its events to a country centroid, so the layer shades whole countries
and never claims a position inside one. Crisp 10m coastlines under a
country-wide fill would imply a precision the numbers do not have — the coarse
outline is the honest match, and it is a twentieth of the size.

## Why FIPS 10-4 and not ISO

Because that is what GDELT emits. `ActionGeo_CountryCode` is FIPS 10-4, so
keying on `FIPS_10` joins the two directly with no lookup table — `UP` is
Ukraine, `RS` is Russia, `CH` is China.

## The `-99` problem

Natural Earth writes `-99` where it has no FIPS code, and six countries are
affected: **Norway, Israel, Palestine, N. Cyprus, Somaliland and South Sudan**.
Joining naively drops all six, which on a conflict map is not a rounding error
— Israel alone was the second-highest country by event count in the sample this
was built against.

So their codes are supplied explicitly in the curation step and recorded in
`meta.curation.overrides`:

- Norway `NO`, Israel `IS`, South Sudan `OD` — ordinary FIPS codes Natural
  Earth simply does not carry.
- Palestine `WE` + `GZ` — FIPS splits the territories into West Bank and Gaza
  Strip while Natural Earth carries one polygon, so both codes resolve to it.
- N. Cyprus `CY`, Somaliland `SO` — not FIPS entities in their own right; they
  fall under the state FIPS recognises, which is where GDELT files events
  occurring in them.

With the overrides the join covers every country code in the feed.

## Curation

Parameters are recorded in `meta.curation`:

- Outer rings only (holes are irrelevant at country-fill zoom).
- Douglas-Peucker simplification at 0.05°, coordinates rounded to 3 decimals.
- Every feature carries `codes`, an array, because one polygon can answer to
  more than one FIPS code.

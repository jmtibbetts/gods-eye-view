# KNOWN ISSUES

Updated: September 26, 2026

This file tracks active runtime issues only.

For the roadmap and open backlog, see the repository issue tracker.

---

## Open

### Street traffic can be slow/uneven when panning across dense city blocks
Status: Open (two named causes fixed; the third is structural)

Context:
- The traffic loader fetches one clamped viewport box at a time (major pass,
  then full pass), so roads outside that box appear only once the camera moves.
- In dense cores, some visible roads can appear late after city jumps or fast pans.

Fixed since this entry was written:
- **The fetch box was not square on the ground.** `clampBoundsAroundCenter`
  capped both axes at 0.05°, which is 5.57 km of latitude anywhere but only
  5.57 km of longitude at the equator — 4.22 km in New York, 3.46 km in London,
  2.79 km in Oslo, 1.94 km in Tromsø. The viewport is wider than it is tall, so
  the shortfall landed on the axis that needed the most coverage and the effect
  grew with latitude. The longitude cap is now divided by cos(latitude), with a
  floor so it stays finite at the poles.
- **A sick mirror could hold the layer for 88 seconds.** Each of the four
  Overpass mirrors got the full 22 s transport timeout in turn, and nothing
  bounded the chain; kumi.systems was measured taking 93 s to return a 504. The
  proxy now spends the query's own declared `[timeout:]` as the budget for the
  whole fan-out (27 s for the major pass, 35 s for the full pass, 45 s for a
  boundary query) and stops rather than handing a mirror a window too small to
  answer in. No query waits longer than it used to.

What remains:
- The box is a fixed ground size, so at the top of the activation band (8 km
  altitude) it still covers roughly a third of the visible width. Widening it
  costs Overpass query area on a service that already refuses this client from
  some mirrors, so it is a tuning question that wants measurement against the
  live upstreams rather than a guess.

Next iteration candidates:
- Prioritize currently visible road segments inside the active viewport before off-center segments.
- Add neighbor prefetch ring for nearby tiles after jump-to-city actions.
- Add adaptive dot cap by frame time (coverage first, density second).
- Promote sync chip from loading indicator to true multi-phase progress.

---

### Height-datum residuals
Status: Open (owner-accepted 2026-07-08; the work itself is merged)

- **Cold-start floor latency:** at a freshly-visited airport, grounded/low aircraft
  float low for ~1–2 poll cycles (30–60 s) and rise as terrain floors resolve;
  a few stragglers take one more poll.
- **Born-grounded first poll:** a contact first seen on the ground with no altitude
  data renders at the geoid for ≤1 poll until its floor cell warms.
- The verification oracle is `scripts/qa-floor-verify.mjs`, which ships on
  `main` alongside the floor service it checks (`src/services/groundFloor.js`).
  The handover write-up it used to cite
  (`docs/superpowers/reports/2026-07-08-height-datum-handover.md`) is not in
  this repository, so the oracle and the service are the record.

---

## Closed / Intentional (for clarity)

### CCTV panel can appear "missing"
Status: Closed — the layer row now opens the panel

Context:
- The rails lay their panels out themselves. No panel is dragged into place at
  startup and no stored position is read, so a panel that looked missing was
  collapsed or its layer was off rather than parked off-screen. The CCTV panel
  starts collapsed and stays that way until you open it or a camera activates.

What changed:
- Every layer row that has a section behind it carries a `PANEL ›` button that
  opens that section, so the two doors to one capability are visibly the same
  door. The Cameras row opens CAMERAS; there is no longer a case where the only
  route to a panel is knowing it exists. See `PANEL_FOR_LAYER` in
  `src/ui/layerPanel.js`.
- The panel also still opens on its own when a camera activates.

If you want it expanded on every ordinary load, the stored state can be set
directly — though a view opened from a share link is laid out from the link and
ignores what this browser stored:
- `localStorage.setItem('godsEyeView.v6.panelCollapsed.cctv-panel', '0');`
- `localStorage.removeItem('godsEyeView.v6.panelCollapsed.cctv-panel');` returns
  it to the default, which is collapsed.

Related keys (current versions):
- Panel collapsed state: `godsEyeView.v6.panelCollapsed.<panel-id>` — `'0'` open,
  `'1'` closed, absent means the panel's own default. A view opened from a share
  link ignores the stored value entirely.
- Panel positions: `godsEyeView.v8.panelPos.<panel-id>` — the versioned name for a
  stored position. The current layout writes none, so deleting one changes
  nothing.
- CCTV calibration: `godsEyeView.cctv.calibration.v2`

---

### Proxy SSRF and error-surface hardening gaps
Status: Closed as fixed on `main`

Context:
- Proxy middleware previously allowed broader error/internal surface area and looser upstream handling.
- Current `main` includes hardened proxy behavior in `vite.config.js`:
  - CCTV upstream URL no longer accepted from client query params.
  - Error payloads are sanitized.
  - OpenSky cache stores successful responses only.
  - OpenSky token refresh is coalesced.
  - GBFS/CCTV memory growth is bounded.

Validation target:
- `vite.config.js`

---

### NVG vignette edge color bleed
Status: Closed as fixed in current shader composite

Context:
- Earlier builds leaked original scene colors near the NVG tube edge.
- Current composite now masks NVG output with tube falloff before final blend, removing the color edge bleed.

Validation target:
- `src/styles/surveillance.js`

---

### Wildfires layer unavailable / static bundled snapshot
Status: Closed — live FIRMS integration shipped (2026-07-16)

Context:
- Wildfires (NASA FIRMS) were removed from runtime in v0.5.3, returned June 2026 as a
  bundled-snapshot layer (`local-firms`, 2026-05-25 data, ~58 MB in-repo), and were
  converted to **live NASA FIRMS data** on 2026-07-16: the `/api/firms` proxy merges
  three VIIRS NRT sources (trailing 24 h, 30 min cache, serve-stale-on-failure) and the
  bundled snapshot was deleted. Requires a free server-side `FIRMS_MAP_KEY`; without it
  the layer shows a KEY REQUIRED state.
- Weather radar is still held out of OSS v1 after QA found the previous overlay did not provide reliable visible value.

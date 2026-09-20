# UX review — how the data is reached, and how to make it one thing

A review of the interface as it stands after the fork's layers and panels,
written from the user's chair: someone who has heard the app can show a
launch, hear the range, follow a plane onto the tower frequency and watch a
weather satellite sweep the ground, and who then has to find those things.
The findings come from the live shell (a 2211 × 1257 window, every panel
opened and measured) and the templates that build it.

## The shape today

The screen has two rails and a strip.

The **left rail** is DATA LAYERS: forty-three ON/OFF rows in seven groups
(Combinations, Movement, Cameras, Infrastructure, Events, Imagery & Weather,
Utilities), each row with a count, a source line, and for some layers a
chip strip and a legend. It answers "what is drawn on the globe".

The **right rail** stacks DISPLAY (post-processing), CCTV (a full camera
console) and CONTEXT — and CONTEXT holds two mode buttons (CONTACTS, SPACE
MISSIONS) and eleven collapsible sections in template order: RADIO,
SCANNERS, SDR / HAM, ATC, MONITOR, WATCHLIST, VESSEL WATCH, LAUNCH, SENSORS,
IMAGERY, TIMELINE. It answers "what can I do".

The **strip** across the bottom is LOCATION, the voice control and VISUAL
PRESETS; the top centre has six globe actions; a receiver dock floats over
the map whenever something plays.

Clicking a thing on the globe draws a card on the map (a canvas overlay,
not DOM) with its details, and for an aircraft the controller frequency it
would be talking to.

## What is incoherent, with the evidence

**1. One capability, two front doors.** Radio, Scanners, SDR, ATC and the
four imagery slots each have a row on the left *and* a section on the
right, and nothing says the two are the same thing. The left row of "Web
SDR Receivers" turns dots on; the right section "SDR / HAM" is where LISTEN
lives. A user who turns the row on sees dots and no way to hear anything;
one who opens the section presses ENABLE and does not know that flipped
the row. Imagery is worse: four left rows (Weather Radar, Geostationary
Weather, Orbital Imagery, Science Overlay) are the same four slots the
IMAGERY section switches products in, and SENSORS and TIMELINE are two more
sections that only make sense as controls *of* imagery.

**2. Sections are named after the source, not the intent.** SDR, ATC, ALPR,
SatNOGS, GIBS, SPC, NWS and OpenMHz appear in titles. The person who wants
to *listen to the tower* has to know that is "ATC"; the one who wants to
*hear the local police* has to know that is "Scanners" and not "Radio". The
right rail's eleven sections are in the order they were built, not the
order anyone thinks in: MONITOR sits between ATC and WATCHLIST, LAUNCH
between VESSEL WATCH and SENSORS.

**3. The verbs are scattered.** The same act carries different names:
LISTEN, TUNE, OPEN, OPEN HERE, PLAY, WATCH, WATCH · LIVE, SHOW, TRACK, FLY
TO, FLY TO PAD, ON PAD, FOCUS, USE THE VIEW, MY LOCATION, PIN, ENABLE.
Status chips likewise: OFF / IDLE / NONE / CLEAR / LIVE / READY / a
countdown. A consistent verb set costs nothing and removes a decision from
every button.

**4. Matched things are not matched on screen.** Click a plane: the card
says "ATC Austin Tower 121.0", but LISTEN is two panels away, FOLLOW PLANE
is in a third. Click a satellite: SENSORS opens (good) but its products are
in IMAGERY. Click a camera: the CCTV console is a separate right-rail
panel. Click a ship: whether it is sanctioned is in VESSEL WATCH. Click a
launch pad: the webcast is in LAUNCH. The app already knows, for every
selected thing, what can be heard, watched, overlaid and followed for it —
it just never puts those actions next to the thing.

**5. The list of forty-three rows has no way in.** No filter, no "what is
on" summary, and the groups mix kind of data (Movement, Cameras) with kind
of use (Utilities), so Directions sits beside Scanners and SatNOGS beside
ATC. "Imagery & Weather" holds fourteen rows.

**6. Two media, one dock, three names.** The dock is "Receiver window" in
its ARIA label, "RECEIVER DOCK" in the code, and its kind chip says SDR /
LIVEATC / PAGE even when it is showing the ISS or a launch webcast. It is
the app's one NOW PLAYING surface for audio *and* video and should say so.

**7. The right rail competes with itself — and the camera console was
winning.** Measured live rather than read off the stylesheet: the rail does
not share its 70 vh between DISPLAY, CCTV and CONTEXT at all. In the
tactical HUD it shows one expanded panel and hides every collapsed sibling,
so the three do not crowd each other; they replace each other. Cameras is
on by default, and the layer nominates its first catalogued camera as
"active" the moment the catalog lands so a frame is ready — which the panel
read as a selection and opened itself for. A first-time visitor therefore
got the camera calibration console, with the Context rail — every verb the
app has — hidden behind it and no visible way back. DISPLAY is reachable
only through the style-parameter path while CONTEXT is open, which is
tolerable for a panel of toggles that all have keyboard shortcuts, and is
not tolerable for the rail of verbs.

## The principle

**Left rail: what is on the globe. Right rail: what you can do with it.**
Every row on the left is a thing drawn; every section on the right is a
verb — INSPECT, LISTEN, WATCH, IMAGERY (look closer), ALERTS (tell me when).
A row that has a verb behind it says so and takes you there. A selected
thing shows its verbs beside itself. One verb has one name everywhere.

## The vocabulary

| Verb | Means | Replaces |
| --- | --- | --- |
| **LISTEN** | audio plays in the dock (or a named tab when the source forbids framing) | TUNE, OPEN HERE, PLAY |
| **WATCH** | video plays in the dock | WATCH · LIVE (kept, as a state of WATCH) |
| **SHOW** | draw it on the globe (a product, a closure, a footprint) | OPEN, SHOW ON MAP |
| **GO TO** | move the camera there | FLY TO, FLY TO PAD, FOCUS |
| **TRACK** | keep the camera on a moving thing | ON PAD |
| **FOLLOW** | retune the radio as a plane moves between Ground, Tower, Approach and Center | FOLLOW PLANE (kept; it is a different act from TRACK) |
| **PIN** | add to the watchlist | — |
| **PANEL ›** | open the section that owns the controls | — |

Status words on section headers: **OFF** (layer off), **READY** (on,
nothing selected), **LIVE** (something playing or a countdown running),
or a count ("3 PINNED", "12 PRODUCTS"). Nothing else.

Section and row names say the thing in plain words first and the source in
brackets or the meta line, never the reverse: "Scanners (police, fire, EMS)",
"Receivers (web SDR / ham)", "Airband (ATC frequencies)", "Plate readers
(ALPR)", "Ground stations (SatNOGS)", "Satellite imagery", "Weather
satellites", "Launches (30 days)". The abbreviation stays for the people
who search by it.

## The target layout

**Left — DATA LAYERS**, with a filter box at the top and groups by domain:

- **Sky & space** — Live Flights, Military Flights, Satellites, Launches,
  Conjunctions, Flight Restrictions, Aviation Hazards, Ground Stations
- **Sea** — Live Vessels, Submarine Cables
- **Ground** — Street Traffic, Transit, Bike Share, Cameras, Plate Readers,
  Military Installations, Data Centers, Dams, Directions
- **Events** — Earthquakes, Volcano Alerts, Active Fires, Conflict Reporting
- **Weather** — Weather Alerts, Storm Reports, Lightning, Tropical Cyclones,
  Severe Outlook, River Flood, Drought, Air Quality, Space Weather
- **Imagery** — Weather Radar, Weather Satellites, Satellite Imagery,
  Science Layers
- **Listen** — Radio, Scanners, Receivers, Airband

Rows with a section behind them carry **PANEL ›**, which opens the Context
rail, expands that section and scrolls to it.

**Right — CONTEXT**, grouped by verb, ids unchanged so share links, saved
collapse state and every test keep working:

- **INSPECT** — the selected thing: its name, its card lines, and the
  actions the app can do for it right now. A plane offers LISTEN (its
  controller), FOLLOW (retune between Ground, Tower, Approach and Center)
  and PIN. A satellite offers SENSORS, PIN and — for the ISS — WATCH. A
  receiver, scanner system or airport offers LISTEN. A camera offers WATCH.
  A ship offers PIN and says whether VESSEL WATCH has it. A launch pad
  offers WATCH and LAUNCH ›. A closure offers the NOTAM. Everything offers
  GO TO. Nothing appears that the app cannot do.
- **LISTEN** — Radio, Scanners, Receivers, Airband
- **WATCH** — Launch (countdowns, webcasts, the range)
- **IMAGERY** — Imagery, then Sensors and Timeline indented as its controls
- **ALERTS** — Monitor, Watchlist, Vessel Watch

The CONTACTS / SPACE MISSIONS mode buttons stay where they are, under a
small MODE label, because they are modes of the whole rail rather than
verbs. The CCTV panel keeps its place (it is a console) but is titled
CAMERAS. The dock is titled by what it is doing — NOW PLAYING for audio,
NOW SHOWING for video — with the source as its subtitle.

## The plan

1. **Vocabulary** (no structure moves): names, status words, verbs, the
   dock title. Cheap, and it makes the next two steps read correctly.
2. **Structure**: regroup the left list and add its filter; group the
   Context sections under verb headings with SENSORS and TIMELINE under
   IMAGERY; PANEL › on the rows that have a section.
3. **INSPECT**: a section at the top of the Context rail driven by the
   selection the app already keeps, rendering matched actions through a
   small registry keyed by layer. This is where "matched things" become one
   thing: the frequency, the feed, the product and the watchlist entry sit
   beside the object they belong to.

Each step ships on its own, verified live, with the gates green.

## What shipped

All three. Vocabulary landed first (rows, sections, verbs, status words,
the dock title), then structure (the filter and the seven groups on the
left, the verb headings on the right with SENSORS and TIMELINE under
IMAGERY, PANEL › on the rows that have a section), then INSPECT at the top
of the Context rail. INSPECT reads the selection the app already keeps and
offers only what its services report they can do: a plane's LISTEN turns
Airband on if it is off and plays the controller the card names; FOLLOW is
the same switch the Airband section has; PIN puts the callsign, MMSI or
satellite name on the WATCHLIST and reads PINNED once it is there; a ship
carries its VESSEL WATCH verdict as far as the OFAC table allows; a closure
links its NOTAM; a camera says where it is and whether it sends video or
stills, and WATCH opens the console that holds its frame. SPACE MISSIONS
keeps its roster, since a mission is a mode of the rail rather than a
thing on the globe.

Then the rail itself, once there was something worth reaching in it. A
folded section is a line rather than a card — twelve of them had come to
1,186 px in a 726 px rail — and the group heading of whatever is being
scrolled through holds the top of its list, on both sides. The modes get a
MODE label instead of a dashed box restating the buttons above it.

Three latent bugs surfaced on the way, each the same shape: a thing the app
knew, kept somewhere nothing else could read. The radio layers registered
their selection on the field dot they hide while something is selected, so
the shared selection slot dropped it the moment anything read it. The
Cameras layer never published its active camera at all. And the Cameras
console treated the layer's boot-time nomination of a default camera as a
selection and expanded for it, which — in a rail that shows one panel and
hides the rest — is why a first run opened on the calibration console with
every verb in the app behind it.

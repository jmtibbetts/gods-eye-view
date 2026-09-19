import { createLayerCatalog } from './catalog.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';
import { createMilitaryRegistry } from '../layers/aircraft/classification.js';
import { createApplicationFlights } from './layers/flights.js';
import { createApplicationMilitary } from './layers/militaryFlights.js';
import { createApplicationVessels } from './layers/aisLiveVessels.js';
import { createApplicationCctv } from './layers/cctv.js';
import { createApplicationRadio } from './layers/radio.js';
import { createApplicationTraffic } from './layers/traffic.js';
import { createApplicationBikeshare } from './layers/bikeshare.js';
import { createApplicationDirections } from './layers/directions.js';
import { createApplicationTransit } from './layers/transit.js';
import { createApplicationInstallations } from './layers/militaryInstallations.js';
import { createApplicationSatellites } from './layers/satellites.js';
import { createApplicationLaunches } from './layers/rocketLaunches.js';
import { createApplicationAlpr } from './layers/alprCameras.js';
import { createApplicationAwareness } from './layers/militaryAwareness.js';
import { createApplicationFirms } from './layers/firms.js';
import { createApplicationEarthquakes } from './layers/earthquakes.js';
import { createApplicationCables } from './layers/submarineCables.js';
import { createApplicationScanner } from './layers/scanner.js';
import { createApplicationSdr } from './layers/sdr.js';
import { createApplicationAtc } from './layers/atc.js';
import { createApplicationImageryOverlays } from './layers/imageryOverlays.js';
import { createApplicationWeatherAlerts } from './layers/weatherAlerts.js';
import { createApplicationStormReports } from './layers/stormReports.js';
import { createApplicationTropical } from './layers/tropical.js';
import { createApplicationAviationHazards } from './layers/aviationHazards.js';
import { createApplicationConflictReports } from './layers/conflictReports.js';
import { createApplicationDrought } from './layers/drought.js';
import { createApplicationLightning } from './layers/lightning.js';
import { createApplicationRiverFlood } from './layers/riverFlood.js';
import { createApplicationSatnogs } from './layers/satnogs.js';
import { createApplicationSevereOutlook } from './layers/severeOutlook.js';
import { createApplicationAirQuality } from './layers/airQuality.js';
import { createApplicationVolcanoes } from './layers/volcanoes.js';
import { createInfrastructureLayers } from '../data/infrastructure.js';
import { localGeoJsonServices } from './localGeojsonServices.js';
import { createBhoteKoshiEventLayer } from '../data/bhoteKoshiEvent.js';
import { createBhoteKoshiLocatorLayer } from '../data/bhoteKoshiLocator.js';

const SOURCE_METHODS = Object.freeze({
  flights: ['getSnapshot'],
  military: ['getSnapshot'],
  vessels: ['getSnapshot'],
  cctv: ['getCatalog', 'getHealth', 'getFrameUrl', 'getMediaUrl'],
  radio: ['getDirectory', 'recordClick'],
  traffic: [
    'requestRoads',
    'getStatus',
    'fetchFlowForBounds',
    'getFlowSessionStats',
    'resetFlowTileCache',
  ],
  bikeshare: ['getStations'],
  installations: ['getMappedSites', 'searchNearby'],
  satellites: ['readGroup'],
  launches: ['getLaunches', 'getActiveTle'],
  alpr: ['fetch'],
  firms: ['getSnapshot'],
  earthquakes: ['getSnapshot'],
  cables: ['fetch'],
  scanner: ['getSeed', 'getSystems', 'getRecentCalls', 'getNewerCalls'],
  sdr: ['getSnapshot'],
  atc: ['getSnapshot'],
  weatherAlerts: ['getSnapshot'],
  stormReports: ['getSnapshot'],
  tropical: ['fetchTropical'],
  aviationHazards: ['fetchSigmets'],
  conflictReports: ['fetchReports'],
  drought: ['fetchDrought'],
  lightning: ['fetchFlashes'],
  riverFlood: ['fetchGauges'],
  satnogs: ['fetchStations'],
  severeOutlook: ['fetchOutlook'],
  airQuality: ['fetchAirQuality'],
  volcanoes: ['getSnapshot'],
});

/** Construct the current catalog without choosing any source provider.
 * Scene engines remain page-owned; layers and classification have this app's lifetime.
 * The manager owns layer destruction, while abort releases classification even if startup fails.
 */
export function createApplicationCatalog({
  surface,
  sources,
  signal,
  metadata = LAYER_STATE_REGISTRY,
  vesselOptions,
  resolveAsset,
  nepalBoundaryResolver,
}) {
  if (!signal?.addEventListener)
    throw new TypeError('An application lifetime signal is required');
  signal.throwIfAborted();
  if (!surface?.groundFloor || !surface?.terrain)
    throw new TypeError('Application surface services are required');

  for (const [name, methods] of Object.entries(SOURCE_METHODS)) {
    if (
      methods.some((method) => typeof sources?.[name]?.[method] !== 'function')
    )
      throw new TypeError(`Invalid catalog source: ${name}`);
  }
  const militaryRegistry = createMilitaryRegistry();
  const dispose = () => {
    signal.removeEventListener('abort', dispose);
    militaryRegistry.dispose();
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    militaryRegistry.configureSource(sources.military, { signal });
    const flights = createApplicationFlights({
      surface,
      source: sources.flights,
      militaryRegistry,
      resolveAsset,
    });
    const military = createApplicationMilitary({
      surface,
      source: sources.military,
      militaryRegistry,
      resolveAsset,
    });
    const vessels = createApplicationVessels({
      source: sources.vessels,
      options: vesselOptions,
    });
    const installations = createApplicationInstallations({
      surface,
      source: sources.installations,
    });
    const satellites = createApplicationSatellites({
      source: sources.satellites,
    });
    const sdr = createApplicationSdr({ surface, source: sources.sdr });
    const catalog = createLayerCatalog(
      [
        createBhoteKoshiEventLayer(),
        createBhoteKoshiLocatorLayer({
          boundaryResolver: nepalBoundaryResolver,
        }),
        flights,
        military,
        createApplicationEarthquakes({ source: sources.earthquakes }),
        createApplicationScanner({ surface, source: sources.scanner }),
        sdr,
        createApplicationAtc({ surface, source: sources.atc, sdr }),
        ...createApplicationImageryOverlays(),
        createApplicationWeatherAlerts({ source: sources.weatherAlerts }),
        createApplicationStormReports({
          surface,
          source: sources.stormReports,
        }),
        createApplicationTropical({ surface, source: sources.tropical }),
        createApplicationAviationHazards({
          source: sources.aviationHazards,
        }),
        createApplicationConflictReports({
          source: sources.conflictReports,
        }),
        createApplicationDrought({ source: sources.drought }),
        createApplicationLightning({ surface, source: sources.lightning }),
        createApplicationRiverFlood({ surface, source: sources.riverFlood }),
        createApplicationSatnogs({ surface, source: sources.satnogs }),
        createApplicationSevereOutlook({ source: sources.severeOutlook }),
        createApplicationAirQuality({ source: sources.airQuality }),
        createApplicationVolcanoes({ surface, source: sources.volcanoes }),
        createApplicationAlpr({ surface, source: sources.alpr }),
        satellites,
        createApplicationLaunches({ source: sources.launches, satellites }),
        createApplicationTraffic({ source: sources.traffic }),
        createApplicationCctv({ surface, source: sources.cctv }),
        createApplicationRadio({ surface, source: sources.radio }),
        createApplicationTransit({ surface, source: sources.transit }),
        createApplicationBikeshare({ source: sources.bikeshare }),
        createApplicationDirections(),
        vessels,
        installations,
        createApplicationAwareness({
          flights,
          military,
          vessels,
          installations,
        }),
        ...createInfrastructureLayers(localGeoJsonServices),
        createApplicationCables({ source: sources.cables }),
        createApplicationFirms({
          surface,
          id: 'local-firms',
          name: 'FIRMS Active Fires',
          icon: '▲',
          source: 'NASA FIRMS · LIVE',
          feed: sources.firms,
        }),
      ],
      metadata,
    );
    return Object.freeze({ ...catalog, militaryRegistry, surface });
  } catch (error) {
    dispose();
    throw error;
  }
}

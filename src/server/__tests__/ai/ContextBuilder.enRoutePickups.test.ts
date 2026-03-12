import { ContextBuilder } from '../../services/ai/ContextBuilder';
import {
  GridPoint, TerrainType, TrackSegment,
  WorldSnapshot, RouteStop, EnRoutePickup,
} from '../../../shared/types/GameTypes';

// ── Helper factories ────────────────────────────────────────────────────────

function makeGridPoint(
  row: number,
  col: number,
  overrides?: Partial<GridPoint>,
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40,
    y: row * 40,
    row,
    col,
    terrain: TerrainType.Clear,
    city: undefined,
    ...overrides,
  };
}

function makeCityPoint(
  row: number,
  col: number,
  name: string,
  terrain: TerrainType = TerrainType.SmallCity,
): GridPoint {
  return makeGridPoint(row, col, {
    terrain,
    city: { type: terrain, name, availableLoads: [] },
  });
}

function makeWorldSnapshot(overrides?: {
  botLoads?: string[];
  botPosition?: { row: number; col: number } | null;
  botSegments?: TrackSegment[];
  botMoney?: number;
  botTrainType?: string;
  resolvedDemands?: Array<{
    cardId: number;
    demands: Array<{ city: string; loadType: string; payment: number }>;
  }>;
  loadAvailability?: Record<string, string[]>;
  gameStatus?: 'active' | 'initialBuild';
}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: overrides?.gameStatus ?? 'active',
    turnNumber: 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: overrides?.botMoney ?? 50,
      position: overrides?.botPosition !== undefined ? overrides.botPosition : { row: 0, col: 0 },
      existingSegments: overrides?.botSegments ?? [],
      demandCards: [1, 2, 3],
      resolvedDemands: overrides?.resolvedDemands ?? [],
      trainType: overrides?.botTrainType ?? 'freight',
      loads: overrides?.botLoads ?? [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: overrides?.loadAvailability ?? {},
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ContextBuilder.computeEnRoutePickups', () => {

  it('should find Budapest bauxite near Zagreb→Århus route', () => {
    // Route: Zagreb (0,0) → Århus (0,10)
    // Budapest at (2,1) — within 3 hex distance of Zagreb
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Zagreb', TerrainType.MediumCity),
      makeCityPoint(0, 10, 'Århus', TerrainType.MediumCity),
      makeCityPoint(2, 1, 'Budapest', TerrainType.MajorCity),
      makeCityPoint(0, 20, 'København', TerrainType.MajorCity),
    ];

    const routeStops: RouteStop[] = [
      { action: 'pickup', loadType: 'Wine', city: 'Zagreb' },
      { action: 'deliver', loadType: 'Wine', city: 'Århus', payment: 20 },
    ];

    const snapshot = makeWorldSnapshot({
      resolvedDemands: [{
        cardId: 1,
        demands: [
          { city: 'København', loadType: 'Bauxite', payment: 30 },
        ],
      }],
      loadAvailability: { 'Budapest': ['Bauxite'] },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      city: 'Budapest',
      load: 'Bauxite',
      demandCity: 'København',
      payoff: 30,
      onRoute: false,
    }));
    expect(result[0].detourMileposts).toBeLessThanOrEqual(3);
  });

  it('should exclude loads with no matching demand card', () => {
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Zagreb', TerrainType.MediumCity),
      makeCityPoint(0, 5, 'Wien', TerrainType.MajorCity),
      makeCityPoint(1, 1, 'NearbyCity', TerrainType.SmallCity),
    ];

    const routeStops: RouteStop[] = [
      { action: 'pickup', loadType: 'Wine', city: 'Zagreb' },
      { action: 'deliver', loadType: 'Wine', city: 'Wien', payment: 15 },
    ];

    const snapshot = makeWorldSnapshot({
      resolvedDemands: [{
        cardId: 1,
        demands: [
          { city: 'Wien', loadType: 'Wine', payment: 15 },
        ],
      }],
      // NearbyCity has Coal but no demand card for Coal
      loadAvailability: { 'NearbyCity': ['Coal'] },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);
    expect(result).toHaveLength(0);
  });

  it('should return empty array when route is empty', () => {
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Zagreb', TerrainType.MediumCity),
    ];

    const snapshot = makeWorldSnapshot({
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Wien', loadType: 'Wine', payment: 15 }],
      }],
      loadAvailability: { 'Zagreb': ['Wine'] },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, [], gridPoints);
    expect(result).toHaveLength(0);
  });

  it('should mark on-route city with onRoute=true and detourMileposts=0', () => {
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Zagreb', TerrainType.MediumCity),
      makeCityPoint(0, 5, 'Wien', TerrainType.MajorCity),
    ];

    const routeStops: RouteStop[] = [
      { action: 'pickup', loadType: 'Wine', city: 'Zagreb' },
      { action: 'deliver', loadType: 'Wine', city: 'Wien', payment: 15 },
    ];

    const snapshot = makeWorldSnapshot({
      resolvedDemands: [{
        cardId: 1,
        demands: [
          { city: 'Wien', loadType: 'Wine', payment: 15 },
          { city: 'Berlin', loadType: 'Steel', payment: 20 },
        ],
      }],
      // Zagreb (a route stop) also has Steel
      loadAvailability: { 'Zagreb': ['Steel'] },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      city: 'Zagreb',
      load: 'Steel',
      onRoute: true,
      detourMileposts: 0,
    }));
  });

  it('should still show pickups when bot is at max capacity', () => {
    // Per spec: "Bot at max capacity → en-route pickups still shown (LLM may decide to drop a load)"
    // BUT: loads already carried are excluded
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Zagreb', TerrainType.MediumCity),
      makeCityPoint(0, 5, 'Wien', TerrainType.MajorCity),
      makeCityPoint(1, 0, 'NearbyCity', TerrainType.SmallCity),
    ];

    const routeStops: RouteStop[] = [
      { action: 'pickup', loadType: 'Wine', city: 'Zagreb' },
      { action: 'deliver', loadType: 'Wine', city: 'Wien', payment: 15 },
    ];

    const snapshot = makeWorldSnapshot({
      botLoads: ['Wine', 'Coal'], // at capacity for Freight (2)
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Steel', payment: 25 }],
      }],
      loadAvailability: { 'NearbyCity': ['Steel'] },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);
    // Steel is available and demanded — should still appear (capacity not checked here)
    expect(result).toHaveLength(1);
    expect(result[0].load).toBe('Steel');
  });

  it('should exclude cities beyond 3 hex distance from all route stops', () => {
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Zagreb', TerrainType.MediumCity),
      makeCityPoint(10, 10, 'FarCity', TerrainType.SmallCity),
    ];

    const routeStops: RouteStop[] = [
      { action: 'pickup', loadType: 'Wine', city: 'Zagreb' },
    ];

    const snapshot = makeWorldSnapshot({
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Steel', payment: 25 }],
      }],
      loadAvailability: { 'FarCity': ['Steel'] },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);
    expect(result).toHaveLength(0);
  });

  it('should return empty during initialBuild phase', () => {
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Zagreb', TerrainType.MediumCity),
      makeCityPoint(1, 1, 'NearbyCity', TerrainType.SmallCity),
    ];

    const routeStops: RouteStop[] = [
      { action: 'pickup', loadType: 'Wine', city: 'Zagreb' },
    ];

    const snapshot = makeWorldSnapshot({
      gameStatus: 'initialBuild',
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Wien', loadType: 'Steel', payment: 20 }],
      }],
      loadAvailability: { 'NearbyCity': ['Steel'] },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);
    expect(result).toHaveLength(0);
  });

  it('should cap results at 5 and sort by net value', () => {
    // Create 7 nearby cities with different payoffs
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'RouteCity', TerrainType.MediumCity),
      makeCityPoint(0, 1, 'City1', TerrainType.SmallCity),
      makeCityPoint(1, 0, 'City2', TerrainType.SmallCity),
      makeCityPoint(1, 1, 'City3', TerrainType.SmallCity),
      makeCityPoint(0, 2, 'City4', TerrainType.SmallCity),
      makeCityPoint(2, 0, 'City5', TerrainType.SmallCity),
      makeCityPoint(2, 1, 'City6', TerrainType.SmallCity),
    ];

    const routeStops: RouteStop[] = [
      { action: 'pickup', loadType: 'Wine', city: 'RouteCity' },
    ];

    const snapshot = makeWorldSnapshot({
      resolvedDemands: [{
        cardId: 1,
        demands: [
          { city: 'Berlin', loadType: 'Load1', payment: 10 },
          { city: 'Berlin', loadType: 'Load2', payment: 20 },
          { city: 'Berlin', loadType: 'Load3', payment: 30 },
        ],
      }, {
        cardId: 2,
        demands: [
          { city: 'Berlin', loadType: 'Load4', payment: 40 },
          { city: 'Berlin', loadType: 'Load5', payment: 50 },
          { city: 'Berlin', loadType: 'Load6', payment: 60 },
        ],
      }],
      loadAvailability: {
        'City1': ['Load1'],
        'City2': ['Load2'],
        'City3': ['Load3'],
        'City4': ['Load4'],
        'City5': ['Load5'],
        'City6': ['Load6'],
      },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);
    expect(result).toHaveLength(5);
    // Highest payoff should be first
    expect(result[0].payoff).toBeGreaterThanOrEqual(result[1].payoff);
  });

  it('should skip loads bot is already carrying', () => {
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Zagreb', TerrainType.MediumCity),
      makeCityPoint(1, 0, 'NearbyCity', TerrainType.SmallCity),
    ];

    const routeStops: RouteStop[] = [
      { action: 'pickup', loadType: 'Wine', city: 'Zagreb' },
    ];

    const snapshot = makeWorldSnapshot({
      botLoads: ['Steel'],
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Steel', payment: 25 }],
      }],
      loadAvailability: { 'NearbyCity': ['Steel'] },
    });

    const result = ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);
    expect(result).toHaveLength(0);
  });
});

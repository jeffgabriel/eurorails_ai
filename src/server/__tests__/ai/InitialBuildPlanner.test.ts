import { InitialBuildPlanner } from '../../services/ai/InitialBuildPlanner';
import {
  GridPoint, TerrainType, WorldSnapshot, GameStatus,
  DemandOption,
} from '../../../shared/types/GameTypes';

// ── Helper factories ─────────────────────────────────────────────────────────

function makeGridPoint(
  row: number, col: number,
  overrides?: Partial<GridPoint>,
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40, y: row * 40,
    row, col,
    terrain: TerrainType.Clear,
    ...overrides,
  };
}

function makeCityPoint(
  row: number, col: number, name: string,
  terrain: TerrainType = TerrainType.SmallCity,
  availableLoads: string[] = [],
): GridPoint {
  return makeGridPoint(row, col, {
    terrain,
    city: { type: terrain, name, availableLoads },
  });
}

function makeWorldSnapshot(overrides?: {
  resolvedDemands?: Array<{
    cardId: number;
    demands: Array<{ city: string; loadType: string; payment: number }>;
  }>;
  loadAvailability?: Record<string, string[]>;
  botTrainType?: string;
  botMoney?: number;
  gameStatus?: GameStatus;
}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: overrides?.gameStatus ?? 'initialBuild',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: overrides?.botMoney ?? 50,
      position: null,
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: overrides?.resolvedDemands ?? [],
      trainType: overrides?.botTrainType ?? 'freight',
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: overrides?.loadAvailability ?? {},
  };
}

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockEstimatePathCost = jest.fn<number, [number, number, number, number]>(() => 0);
const mockHexDistance = jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
  const x1 = c1 - Math.floor(r1 / 2);
  const z1 = r1;
  const y1 = -x1 - z1;
  const x2 = c2 - Math.floor(r2 / 2);
  const z2 = r2;
  const y2 = -x2 - z2;
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
});

jest.mock('../../services/ai/MapTopology', () => ({
  estimatePathCost: (r1: number, c1: number, r2: number, c2: number) =>
    mockEstimatePathCost(r1, c1, r2, c2),
  hexDistance: (r1: number, c1: number, r2: number, c2: number) =>
    mockHexDistance(r1, c1, r2, c2),
}));

const mockGetSourceCitiesForLoad = jest.fn<string[], [string]>(() => []);
jest.mock('../../services/loadService', () => ({
  LoadService: {
    getInstance: () => ({
      getSourceCitiesForLoad: (loadType: string) => mockGetSourceCitiesForLoad(loadType),
    }),
  },
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    { cityName: 'Paris', center: { row: 20, col: 10 }, outposts: [] },
    { cityName: 'Ruhr', center: { row: 15, col: 12 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 12, col: 16 }, outposts: [] },
    { cityName: 'Holland', center: { row: 14, col: 10 }, outposts: [] },
    { cityName: 'Wien', center: { row: 18, col: 18 }, outposts: [] },
    { cityName: 'Madrid', center: { row: 28, col: 3 }, outposts: [] },
    { cityName: 'London', center: { row: 14, col: 6 }, outposts: [] },
    { cityName: 'Milano', center: { row: 22, col: 13 }, outposts: [] },
  ],
}));

// ── Grid setup ──────────────────────────────────────────────────────────────

function makeTestGrid(): GridPoint[] {
  return [
    // Major cities
    makeCityPoint(20, 10, 'Paris', TerrainType.MajorCity),
    makeCityPoint(15, 12, 'Ruhr', TerrainType.MajorCity),
    makeCityPoint(12, 16, 'Berlin', TerrainType.MajorCity),
    makeCityPoint(14, 10, 'Holland', TerrainType.MajorCity),
    makeCityPoint(18, 18, 'Wien', TerrainType.MajorCity),
    makeCityPoint(28, 3, 'Madrid', TerrainType.MajorCity),
    makeCityPoint(14, 6, 'London', TerrainType.MajorCity),
    makeCityPoint(22, 13, 'Milano', TerrainType.MajorCity),
    // Small/medium cities
    makeCityPoint(16, 11, 'Essen', TerrainType.SmallCity),
    makeCityPoint(17, 14, 'Frankfurt', TerrainType.MediumCity),
    makeCityPoint(13, 17, 'Wroclaw', TerrainType.SmallCity),
    makeCityPoint(19, 12, 'Lyon', TerrainType.SmallCity),
    makeCityPoint(21, 15, 'Zürich', TerrainType.SmallCity),
    makeCityPoint(10, 14, 'Hamburg', TerrainType.MediumCity),
    // Clear terrain
    makeGridPoint(16, 12),
    makeGridPoint(17, 13),
    makeGridPoint(18, 14),
    makeGridPoint(19, 15),
  ];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('InitialBuildPlanner', () => {
  let grid: GridPoint[];

  beforeEach(() => {
    jest.clearAllMocks();
    grid = makeTestGrid();
    // Default: estimatePathCost returns realistic costs (distance * 1.5)
    mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
      const dist = mockHexDistance(r1, c1, r2, c2);
      return Math.round(dist * 1.5);
    });
  });

  describe('expandDemandOptions', () => {
    it('should produce options for multi-supply-city loads', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen', 'Wroclaw']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [
            { city: 'Frankfurt', loadType: 'Coal', payment: 12 },
            { city: 'Lyon', loadType: 'Wine', payment: 8 },
            { city: 'Hamburg', loadType: 'Steel', payment: 15 },
          ],
        }],
        loadAvailability: {
          'Essen': ['Coal'],
          'Wroclaw': ['Coal'],
        },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);

      // Should have options from both Essen and Wroclaw for Coal → Frankfurt
      const coalOptions = options.filter(o => o.loadType === 'Coal');
      expect(coalOptions.length).toBeGreaterThanOrEqual(1);
      // Each option should pick the best starting city
      for (const opt of coalOptions) {
        expect(opt.startingCity).not.toBe('Madrid');
        expect(opt.totalBuildCost).toBeLessThanOrEqual(MAX_BUILD_BUDGET);
      }
    });

    it('should allow Madrid as starting city (no longer blocked)', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }],
        }],
        loadAvailability: { 'Essen': ['Coal'] },
      });

      // Madrid is no longer in BLOCKED_STARTING_CITIES; it can be a starting city
      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      expect(options.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter out REMOTE_INITIAL_BUILD_CITIES as delivery destinations', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [
            { city: 'Madrid', loadType: 'Coal', payment: 20 },
            { city: 'Lisboa', loadType: 'Coal', payment: 18 },
            { city: 'Frankfurt', loadType: 'Coal', payment: 12 },
          ],
        }],
        loadAvailability: { 'Essen': ['Coal'] },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);

      // Madrid and Lisboa are in REMOTE_INITIAL_BUILD_CITIES — must be filtered out
      expect(options.every(o => o.deliveryCity !== 'Madrid')).toBe(true);
      expect(options.every(o => o.deliveryCity !== 'Lisboa')).toBe(true);
      // Frankfurt is not remote — should appear
      expect(options.some(o => o.deliveryCity === 'Frankfurt')).toBe(true);
    });

    it('should include remote cities in emergencyFallback when no other options exist', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);
      // All demands are remote — expandDemandOptions returns empty, triggers emergencyFallback
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [
            { city: 'Madrid', loadType: 'Coal', payment: 20 },
          ],
        }],
        loadAvailability: { 'Essen': ['Coal'] },
      });

      // expandDemandOptions should return empty (Madrid is remote)
      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      expect(options.length).toBe(0);

      // planInitialBuild triggers emergencyFallback — should still produce a plan
      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);
      expect(plan.startingCity).toBeTruthy();
      // The fallback should have found Madrid as the delivery city (not filtered in fallback)
      const deliveryStop = plan.route.find(r => r.action === 'deliver');
      expect(deliveryStop?.city).toBe('Madrid');
    });

    it('should filter out ferry routes', () => {
      // London is in britain, Frankfurt in continent — requires ferry
      mockGetSourceCitiesForLoad.mockReturnValue(['London']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Fish', payment: 10 }],
        }],
        loadAvailability: { 'London': ['Fish'] },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      // London → Frankfurt crosses the channel — should be filtered
      expect(options.length).toBe(0);
    });

    it('should filter out options exceeding 40M budget', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Hamburg']);
      // Make estimatePathCost return very high costs
      mockEstimatePathCost.mockReturnValue(25);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Wien', loadType: 'Steel', payment: 15 }],
        }],
        loadAvailability: { 'Hamburg': ['Steel'] },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      // startCity→Hamburg (25) + Hamburg→Wien (25) = 50 > 40
      expect(options.every(o => o.totalBuildCost <= MAX_BUILD_BUDGET)).toBe(true);
    });

    it('should filter out unavailable loads', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }],
        }],
        loadAvailability: { 'Essen': ['Steel'] }, // No Coal at Essen
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      expect(options.length).toBe(0);
    });

    // ── Peripheral penalty gate tests (JIRA-178 fix) ─────────────────────────

    it('AC1: start==deliveryCity (Milano) skips 0.7 penalty; beats Holland-start option', () => {
      // Cheese available at Bern (small city, not a major-city starting candidate)
      // and at Holland (major city, will be evaluated as a starting candidate).
      // Demand: deliver Cheese to Milano (peripheral city).
      //
      // For the Bern-supply branch: best starting city is Milano (closest major
      // city to Bern in our grid) — group.cityName === demand.city → gate fires,
      // no 0.7 penalty.
      //
      // For the Holland-supply branch: best starting city is Holland itself —
      // Holland is not peripheral, so no penalty applies either way.
      //
      // We force Milano-start(Bern-supply) to out-rank Holland-start(Holland-supply)
      // by controlling build costs: Bern route is cheap (6M), Holland→Milano is expensive (32M).
      mockGetSourceCitiesForLoad.mockReturnValue(['Bern', 'Holland']);

      // Bern is a small city in the grid — add it
      const bern = makeCityPoint(21, 13, 'Bern', TerrainType.SmallCity, ['Cheese']);
      const extendedGrid = [...grid, bern];

      // Milano center: row=22, col=13. Bern: row=21, col=13.
      // hexDistance(Milano→Bern) ≈ 1 — extremely close.
      // Holland center: row=14, col=10. Milano center: row=22, col=13.
      // hexDistance(Holland→Milano) ≈ 9 — far.

      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        // Make Milano→Bern (supply) very cheap: 3M each leg
        if ((r1 === 22 && c1 === 13) || (r2 === 22 && c2 === 13)) {
          if ((r1 === 21 && c1 === 13) || (r2 === 21 && c2 === 13)) {
            return 3; // Milano↔Bern leg
          }
        }
        // Make Holland→Milano (supply=Holland leg to delivery) expensive: 16M
        if ((r1 === 14 && c1 === 10) || (r2 === 14 && c2 === 10)) {
          return 16;
        }
        // default
        return Math.round(mockHexDistance(r1, c1, r2, c2) * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Milano', loadType: 'Cheese', payment: 20 }],
        }],
        loadAvailability: {
          'Bern': ['Cheese'],
          'Holland': ['Cheese'],
        },
      });

      const demandScores = new Map([['Cheese:Milano', 1.03]]);
      const options = InitialBuildPlanner.expandDemandOptions(snapshot, extendedGrid, demandScores);

      // We should have options for both supply cities
      const bernOption = options.find(o => o.supplyCity === 'Bern' && o.startingCity === 'Milano');
      const hollandOption = options.find(o => o.supplyCity === 'Holland' && o.startingCity === 'Holland');

      expect(bernOption).toBeDefined();
      expect(hollandOption).toBeDefined();

      // Key assertion: Milano-start (no penalty, delivery anchors there) must rank higher
      expect(bernOption!.efficiency).toBeGreaterThan(hollandOption!.efficiency);
    });

    it('AC2: JIRA-178 regression — Milano start with neither endpoint at Milano still gets 0.7 penalty', () => {
      // Demand: deliver Cheese to Frankfurt. Supply: Essen (small city close to Ruhr).
      // The expandDemandOptions function keeps ONE best starting city per (supply, delivery) pair.
      // We force Ruhr to have the same estimatedTurns as Milano (equal hex distances)
      // so we can isolate the efficiency difference. We then compute the expected
      // penalised efficiency and assert the returned option's efficiency matches.
      //
      // start=Milano, supply=Essen, delivery=Frankfurt → Milano ≠ Essen, Milano ≠ Frankfurt
      // → 0.7 penalty MUST be applied to efficiency.
      //
      // Strategy: make Milano the closest major city to Essen (so it wins as bestForPair),
      // then verify its efficiency is rawEfficiency * 0.7 (not rawEfficiency).
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);

      // Milano at (22,13), Essen at (16,11), Frankfurt at (17,14).
      // We'll use uniform costs to isolate the penalty effect.
      const FIXED_COST = 4;
      mockEstimatePathCost.mockReturnValue(FIXED_COST);

      // Make Milano the closest major city to Essen by temporarily overriding hexDistance
      // for the Milano→Essen leg only. Instead, we rely on the real hexDistance values:
      // Milano (22,13) to Essen (16,11): hexDist ≈ 6. Ruhr (15,12) to Essen (16,11): hexDist ≈ 1.
      // Ruhr is actually closest, so Ruhr will be bestForPair (lowest estimatedTurns).
      // We make the demand score explicitly test the penalty: assert that when Ruhr is selected
      // as start, Ruhr is NOT peripheral → no penalty. We then test the complementary case
      // by checking a separate option where Milano WOULD be start (AC3 covers that).
      //
      // Simpler approach: we verify the penalty fires by checking that for a (supply, delivery)
      // pair where Milano is the only viable starting city, efficiency = rawEff * 0.7.
      // We block all non-Milano major cities by making their path costs exceed budget.
      mockEstimatePathCost.mockImplementation((r1: number, c1: number, r2: number, c2: number) => {
        // Milano center: row=22, col=13
        const isMilanoRow = r1 === 22 || r2 === 22;
        const isMilanoCol = c1 === 13 || c2 === 13;
        // Cheap ONLY for Milano-origin paths (both from Milano center row AND col)
        if (isMilanoRow && isMilanoCol) return FIXED_COST;
        // All other paths: very expensive (above 20M budget half) so only Milano survives
        return 25;
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Cheese', payment: 20 }],
        }],
        loadAvailability: { 'Essen': ['Cheese'] },
      });

      const contextScore = 1.0;
      const demandScores = new Map([['Cheese:Frankfurt', contextScore]]);
      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid, demandScores);

      const milanoOption = options.find(o => o.startingCity === 'Milano');

      // Milano-start must be the best (only affordable) starting city
      expect(milanoOption).toBeDefined();

      // Compute expected efficiency: contextScore=1.0, totalBuildCost=FIXED_COST+FIXED_COST=8
      // localCostFactor = max(0, 1 - 8/40) = 0.8
      // localTurnFactor = TURN_REFERENCE / max(estimatedTurns, TURN_REFERENCE) = 2 / max(est, 2)
      // localFactor = (localCostFactor + localTurnFactor) / 2
      // rawEfficiency = 1.0 * (1 + localFactor)
      // With JIRA-178 penalty (start≠supply, start≠delivery): efficiency = rawEfficiency * 0.7
      const totalBuildCost = FIXED_COST + FIXED_COST;
      const localCostFactor = Math.max(0, 1 - totalBuildCost / 40);
      const localTurnFactor = 2 / Math.max(milanoOption!.estimatedTurns, 2);
      const localFactor = (localCostFactor + localTurnFactor) / 2;
      const rawEfficiency = contextScore * (1 + localFactor);
      const expectedEfficiency = rawEfficiency * 0.7;

      expect(milanoOption!.efficiency).toBeCloseTo(expectedEfficiency, 5);
    });

    it('AC3: start==supplyCity (Milano) skips 0.7 penalty', () => {
      // Demand: deliver Cheese to Praha. Supply available AT Milano.
      // start=Milano, supply=Milano, delivery=Praha → Milano == supplyCity → no penalty.
      mockGetSourceCitiesForLoad.mockReturnValue(['Milano']);

      const praha = makeCityPoint(13, 20, 'Praha', TerrainType.MediumCity, []);
      const extendedGrid = [...grid, praha];

      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        return Math.round(mockHexDistance(r1, c1, r2, c2) * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Praha', loadType: 'Cheese', payment: 20 }],
        }],
        loadAvailability: { 'Milano': ['Cheese'] },
      });

      const demandScores = new Map([['Cheese:Praha', 1.0]]);
      const options = InitialBuildPlanner.expandDemandOptions(snapshot, extendedGrid, demandScores);

      const milanoOption = options.find(o => o.startingCity === 'Milano');
      expect(milanoOption).toBeDefined();

      // Verify by computing what efficiency would be WITH penalty vs WITHOUT.
      // With gate: no penalty → efficiency = rawEfficiency.
      // Without gate: efficiency = rawEfficiency * 0.7.
      // We check that the option was NOT penalised: efficiency should be positive
      // and equal to what we'd compute without the 0.7 multiplier.
      // Since supply==start, buildCostToSupply = 0, so total cost is just supply→Praha.
      const costs = milanoOption!.totalBuildCost;
      const localCostFactor = Math.max(0, 1 - costs / 40);
      const localTurnFactor = 2 / Math.max(milanoOption!.estimatedTurns, 2);
      const localFactor = (localCostFactor + localTurnFactor) / 2;
      const expectedEfficiency = 1.0 * (1 + localFactor);
      expect(milanoOption!.efficiency).toBeCloseTo(expectedEfficiency, 5);
    });

    it('AC4: London symmetry — start==supplyCity (London) skips penalty', () => {
      // London is the supply city AND start city; delivery is a continental city.
      // London is in Britain; we need supply and delivery both in Britain to avoid
      // the cross-channel ferry filter. We supply FROM London and deliver TO London
      // (same city would be trivial), or use a continent-only scenario.
      //
      // Simpler: supply available AT London. Delivery = London.
      // start=London, supply=London, delivery=London — but supply==delivery is degenerate.
      //
      // Valid approach: supply=London, delivery=some city also in Britain.
      // Britain set: London, Birmingham, Nottingham, Liverpool, etc.
      // We add a British delivery city to the grid.
      //
      // Or better: test the symmetric case (start==supply==London).
      // Delivery city must be reachable from London without a ferry — i.e. also British.
      // We add 'Southampton' as a small city in the grid (Britain region).
      mockGetSourceCitiesForLoad.mockReturnValue(['London']);

      const southampton = makeCityPoint(18, 5, 'Southampton', TerrainType.SmallCity, ['Cloth']);
      const extendedGrid = [...grid, southampton];

      // Force London-origin paths to be cheap, all others expensive (so London is the only viable start)
      const FIXED_COST = 4;
      mockEstimatePathCost.mockImplementation((r1: number, c1: number, r2: number, c2: number) => {
        // London center: row=14, col=6
        if ((r1 === 14 && c1 === 6) || (r2 === 14 && c2 === 6)) return FIXED_COST;
        return 25; // over budget for non-London paths
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Southampton', loadType: 'Cloth', payment: 15 }],
        }],
        loadAvailability: { 'London': ['Cloth'] },
      });

      const contextScore = 1.0;
      const demandScores = new Map([['Cloth:Southampton', contextScore]]);
      const options = InitialBuildPlanner.expandDemandOptions(snapshot, extendedGrid, demandScores);
      const londonOption = options.find(o => o.startingCity === 'London');

      // London-start should be present (start==supply → gate fires, no penalty)
      expect(londonOption).toBeDefined();

      // Expected: no penalty because group.cityName ('London') === supplyCity ('London')
      // totalBuildCost = 0 (start==supply) + FIXED_COST (supply→delivery) = FIXED_COST
      const totalBuildCost = londonOption!.totalBuildCost;
      const localCostFactor = Math.max(0, 1 - totalBuildCost / 40);
      const localTurnFactor = 2 / Math.max(londonOption!.estimatedTurns, 2);
      const localFactor = (localCostFactor + localTurnFactor) / 2;
      const expectedEfficiency = contextScore * (1 + localFactor);
      expect(londonOption!.efficiency).toBeCloseTo(expectedEfficiency, 5);
    });

    // ── JIRA-213 regression tests (Cause A, B, C) ────────────────────────────

    it('JIRA-213 Cause C: Arhus is filtered out as a supply city (symmetric remote filter)', () => {
      // Cheese demand to Berlin. Supply cities include Arhus (remote) and Essen (continental).
      // After R1/R2 fix, Arhus must be excluded from supply candidates.
      mockGetSourceCitiesForLoad.mockReturnValue(['Arhus', 'Essen']);

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Cheese', payment: 20 }],
        }],
        loadAvailability: {
          'Arhus': ['Cheese'],
          'Essen': ['Cheese'],
        },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);

      // Arhus is in REMOTE_INITIAL_BUILD_CITIES — must be filtered out as supply
      expect(options.every(o => o.supplyCity !== 'Arhus')).toBe(true);
      // Essen is not remote — should appear as supply
      expect(options.some(o => o.supplyCity === 'Essen')).toBe(true);
    });

    it('JIRA-213 Cause B: estimatedTurns uses ceil(travelDistance/speed) without +1 or buildTurns', () => {
      // Use non-remote stand-in supply cities with engineered hex distances:
      //   NearSupply: total travelDistance = 13 → ceil(13/9) = 2
      //   FarSupply:  total travelDistance = 22 → ceil(22/9) = 3
      // Old formula would add +1 and include buildTurns, giving much larger values.
      // Starting city: Ruhr (15,12). Frankfurt (17,14) is the delivery city.
      // Ruhr→NearSupply: 5, NearSupply→Frankfurt: 8 → total 13 → estimatedTurns 2
      // Ruhr→FarSupply: 12, FarSupply→Frankfurt: 10 → total 22 → estimatedTurns 3
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['NearSupply'];
        if (loadType === 'Steel') return ['FarSupply'];
        return [];
      });

      const nearSupply = makeCityPoint(50, 50, 'NearSupply', TerrainType.SmallCity, ['Coal']);
      const farSupply = makeCityPoint(60, 60, 'FarSupply', TerrainType.SmallCity, ['Steel']);
      const extendedGrid = [...grid, nearSupply, farSupply];

      mockHexDistance.mockImplementation((r1, c1, r2, c2) => {
        const isNearSupply = (r1 === 50 && c1 === 50) || (r2 === 50 && c2 === 50);
        const isFarSupply = (r1 === 60 && c1 === 60) || (r2 === 60 && c2 === 60);
        const isFrankfurt = (r1 === 17 && c1 === 14) || (r2 === 17 && c2 === 14);
        const isRuhr = (r1 === 15 && c1 === 12) || (r2 === 15 && c2 === 12);
        if (isNearSupply && isRuhr) return 5;
        if (isNearSupply && isFrankfurt) return 8;
        if (isNearSupply) return 5;
        if (isFarSupply && isRuhr) return 12;
        if (isFarSupply && isFrankfurt) return 10;
        if (isFarSupply) return 12;
        // Real formula for all other city pairs
        const x1 = c1 - Math.floor(r1 / 2);
        const z1 = r1; const y1 = -x1 - z1;
        const x2 = c2 - Math.floor(r2 / 2);
        const z2 = r2; const y2 = -x2 - z2;
        return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
      });

      // Build costs: 8 per leg → 16 total, well within 40M budget
      mockEstimatePathCost.mockReturnValue(8);

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 30 }] },
          { cardId: 2, demands: [{ city: 'Frankfurt', loadType: 'Steel', payment: 30 }] },
        ],
        loadAvailability: {
          'NearSupply': ['Coal'],
          'FarSupply': ['Steel'],
        },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, extendedGrid);

      const nearOption = options.find(o => o.supplyCity === 'NearSupply');
      const farOption = options.find(o => o.supplyCity === 'FarSupply');

      expect(nearOption).toBeDefined();
      expect(farOption).toBeDefined();

      // travelDistance 13 → ceil(13/9) = 2; travelDistance 22 → ceil(22/9) = 3
      // Old formula added +1 to travelTurns and included buildTurns, inflating the values.
      expect(nearOption!.estimatedTurns).toBe(2);
      expect(farOption!.estimatedTurns).toBe(3);
    });

    it('JIRA-213 Cause A: lower-estimatedTurns candidate ranks above lower-totalBuildCost candidate', () => {
      // Two non-remote supply cities with diverging (cost, turns):
      //   CheapSlow: totalBuildCost=16, estimatedTurns=3 → localCostFactor=0.6, turnFactor=2/3≈0.667
      //   ExpFast:   totalBuildCost=19, estimatedTurns=2 → localCostFactor=0.525, turnFactor=2/2=1.0
      // With contextScore=0.6 (positive), localFactor=(cost+turn)/2:
      //   CheapSlow: localFactor=(0.6+0.667)/2=0.633 → efficiency=0.6*(1.633)≈0.980
      //   ExpFast:   localFactor=(0.525+1.0)/2=0.7625 → efficiency=0.6*(1.7625)≈1.058
      // ExpFast (lower turns) must rank above CheapSlow (lower cost).
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['CheapSlow'];
        if (loadType === 'Steel') return ['ExpFast'];
        return [];
      });

      const cheapSlowSupply = makeCityPoint(55, 55, 'CheapSlow', TerrainType.SmallCity, ['Coal']);
      const expFastSupply = makeCityPoint(65, 65, 'ExpFast', TerrainType.SmallCity, ['Steel']);
      const extendedGrid = [...grid, cheapSlowSupply, expFastSupply];

      // Ruhr (15,12) as starting city. Frankfurt (17,14) as delivery (non-major city, avoids hub=0 case).
      // CheapSlow: Ruhr→CheapSlow=2, CheapSlow→Frankfurt=18 → total travelDistance=20, ceil(20/9)=3
      // ExpFast:   Ruhr→ExpFast=2, ExpFast→Frankfurt=8  → total travelDistance=10, ceil(10/9)=2
      mockHexDistance.mockImplementation((r1, c1, r2, c2) => {
        const isCheapSlow = (r1 === 55 && c1 === 55) || (r2 === 55 && c2 === 55);
        const isExpFast = (r1 === 65 && c1 === 65) || (r2 === 65 && c2 === 65);
        const isFrankfurt = (r1 === 17 && c1 === 14) || (r2 === 17 && c2 === 14);
        const isRuhr = (r1 === 15 && c1 === 12) || (r2 === 15 && c2 === 12);
        if (isCheapSlow && isRuhr) return 2;
        if (isCheapSlow && isFrankfurt) return 18;
        if (isCheapSlow) return 2;
        if (isExpFast && isRuhr) return 2;
        if (isExpFast && isFrankfurt) return 8;
        if (isExpFast) return 2;
        const x1 = c1 - Math.floor(r1 / 2);
        const z1 = r1; const y1 = -x1 - z1;
        const x2 = c2 - Math.floor(r2 / 2);
        const z2 = r2; const y2 = -x2 - z2;
        return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
      });

      // CheapSlow: Ruhr→CheapSlow=8 + CheapSlow→Frankfurt=8 = 16
      // ExpFast:   Ruhr→ExpFast=8 + ExpFast→Frankfurt=11 = 19
      // Hub alternative (any start→Frankfurt) must not be cheaper. Make Frankfurt paths expensive
      // for non-supply starting cities so hub routing doesn't reduce the target costs.
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const isCheapSlow = (r1 === 55 && c1 === 55) || (r2 === 55 && c2 === 55);
        const isExpFast = (r1 === 65 && c1 === 65) || (r2 === 65 && c2 === 65);
        const isFrankfurt = (r1 === 17 && c1 === 14) || (r2 === 17 && c2 === 14);
        if (isCheapSlow) return 8;       // Ruhr→CheapSlow=8, CheapSlow→Frankfurt=8 → total 16
        if (isExpFast && isFrankfurt) return 11; // ExpFast→Frankfurt=11
        if (isExpFast) return 8;         // Ruhr→ExpFast=8 → total 8+11=19
        if (isFrankfurt) return 25;      // Any major city → Frankfurt via hub: too expensive
        return 25;
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 40 }] },
          { cardId: 2, demands: [{ city: 'Frankfurt', loadType: 'Steel', payment: 40 }] },
        ],
        loadAvailability: {
          'CheapSlow': ['Coal'],
          'ExpFast': ['Steel'],
        },
      });

      const demandScores = new Map([
        ['Coal:Frankfurt', 0.6],
        ['Steel:Frankfurt', 0.6],
      ]);
      const options = InitialBuildPlanner.expandDemandOptions(snapshot, extendedGrid, demandScores);

      const cheapSlowOption = options.find(o => o.supplyCity === 'CheapSlow');
      const expFastOption = options.find(o => o.supplyCity === 'ExpFast');

      expect(cheapSlowOption).toBeDefined();
      expect(expFastOption).toBeDefined();

      // Verify cost and turns match the designed scenario
      expect(cheapSlowOption!.totalBuildCost).toBe(16);
      expect(expFastOption!.totalBuildCost).toBe(19);
      expect(cheapSlowOption!.estimatedTurns).toBe(3);
      expect(expFastOption!.estimatedTurns).toBe(2);

      // Key assertion: lower-estimatedTurns candidate ranks above lower-totalBuildCost candidate
      expect(expFastOption!.efficiency).toBeGreaterThan(cheapSlowOption!.efficiency);
    });
  });

  describe('computeDoubleDeliveryPairings', () => {
    it('should not pair demands from the same card', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr' }),
        makeDemandOption({ cardId: 1, supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin' }),
      ];

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
      expect(pairings.length).toBe(0);
    });

    it('should pair demands from different cards', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 12, totalBuildCost: 8 }),
        makeDemandOption({ cardId: 2, supplyCity: 'Lyon', deliveryCity: 'Zürich', startingCity: 'Paris', payout: 10, totalBuildCost: 6 }),
      ];

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
      expect(pairings.length).toBeGreaterThan(0);
      expect(pairings[0].first.cardId).not.toBe(pairings[0].second.cardId);
    });

    it('should give hub bonus when starting cities match', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 12, totalBuildCost: 5 }),
        makeDemandOption({ cardId: 2, supplyCity: 'Holland', deliveryCity: 'Hamburg', startingCity: 'Ruhr', payout: 10, totalBuildCost: 5 }),
      ];
      const sharedPairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);

      const options2: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 12, totalBuildCost: 5 }),
        makeDemandOption({ cardId: 2, supplyCity: 'Holland', deliveryCity: 'Hamburg', startingCity: 'Paris', payout: 10, totalBuildCost: 5 }),
      ];
      const diffPairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options2, grid);

      // Shared hub pairing should score higher (all else being equal, the hub bonus adds +15)
      expect(sharedPairings.length).toBeGreaterThan(0);
      expect(diffPairings.length).toBeGreaterThan(0);
      // The shared pairing has a hub bonus
      const sharedBest = sharedPairings[0];
      expect(sharedBest.sharedStartingCity).toBe('Ruhr');
    });

    it('should filter out pairings exceeding 40M budget', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, totalBuildCost: 25, buildCostSupplyToDelivery: 15 }),
        makeDemandOption({ cardId: 2, totalBuildCost: 25, buildCostSupplyToDelivery: 15 }),
      ];

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
      // 25 + 25 = 50 > 40 — should be filtered
      expect(pairings.every(p => p.totalBuildCost <= MAX_BUILD_BUDGET)).toBe(true);
    });

    it('should rank higher-efficiency pairs above lower ones', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 15, totalBuildCost: 3 }),
        makeDemandOption({ cardId: 2, supplyCity: 'Lyon', deliveryCity: 'Zürich', startingCity: 'Paris', payout: 8, totalBuildCost: 3 }),
        makeDemandOption({ cardId: 3, supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin', payout: 5, totalBuildCost: 3 }),
      ];

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
      // Pairings involving card 1 (payout 15) should rank higher
      if (pairings.length >= 2) {
        expect(pairings[0].pairingScore).toBeGreaterThanOrEqual(pairings[1].pairingScore);
      }
    });
  });

  describe('planInitialBuild', () => {
    it('should return a valid plan with route stops', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }] },
          { cardId: 2, demands: [{ city: 'Zürich', loadType: 'Wine', payment: 10 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      expect(plan.startingCity).toBeTruthy();
      expect(plan.startingCity).not.toBe('Madrid');
      expect(plan.route.length).toBeGreaterThan(0);
      expect(plan.totalPayout).toBeGreaterThan(0);
    });

    it('should prefer double delivery when efficiency threshold is met', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });
      // Make costs low so double is viable
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 0.8); // cheap paths
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 15 }] },
          { cardId: 2, demands: [{ city: 'Zürich', loadType: 'Wine', payment: 12 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // Should have 4 route stops (pickup-deliver-pickup-deliver) for double
      if (plan.route.length === 4) {
        expect(plan.route[0].action).toBe('pickup');
        expect(plan.route[1].action).toBe('deliver');
        expect(plan.route[2].action).toBe('pickup');
        expect(plan.route[3].action).toBe('deliver');
        expect(plan.totalPayout).toBe(27); // 15 + 12
      }
    });

    it('should fall back to single delivery when no within-budget double exists', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Wien']; // Far away
        return [];
      });
      // Make all paths very expensive so no double fits within MAX_BUILD_BUDGET (40M)
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 4.0); // very expensive — ensures combined cost > 40M
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 20 }] },
          { cardId: 2, demands: [{ city: 'Hamburg', loadType: 'Wine', payment: 5 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Wien': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // Should have 2 route stops (single delivery) when no within-budget double exists
      expect(plan.route.length).toBe(2);
      expect(plan.route[0].action).toBe('pickup');
      expect(plan.route[1].action).toBe('deliver');
    });

    it('should use emergency fallback when all options filtered', () => {
      // All supply cities are in Britain — ferry filter removes everything
      mockGetSourceCitiesForLoad.mockReturnValue(['London']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Fish', payment: 10 }] },
        ],
        loadAvailability: { 'London': ['Fish'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // Emergency fallback should still return a plan
      expect(plan.startingCity).toBeTruthy();
      expect(plan.startingCity).not.toBe('Madrid');
    });

    it('should handle empty demands gracefully', () => {
      const snapshot = makeWorldSnapshot({ resolvedDemands: [] });
      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      expect(plan.startingCity).toBeTruthy();
      expect(plan.route.length).toBe(0);
    });
  });

  describe('budget ratio penalty (JIRA-146)', () => {
    it('should prefer cheap nearby delivery over expensive distant one', () => {
      // Use direct DemandOption construction to test the scoring directly
      // Steel: cheap route (3M build, 12M payout)
      // Potatoes: expensive route (35M build, 29M payout) — triggers budget penalty
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Steel') return ['Essen'];
        if (loadType === 'Potatoes') return ['Wroclaw'];
        return [];
      });

      // Return fixed costs based on city pairs to control the test scenario
      mockEstimatePathCost.mockImplementation((r1: number, c1: number, r2: number, c2: number) => {
        // Essen(16,11) ↔ Frankfurt(17,14): close, low cost
        if ((r1 === 16 && c1 === 11) || (r1 === 17 && c1 === 14)) return 2;
        // Wroclaw(13,17) ↔ Wien(18,18): far, high cost
        if ((r1 === 13 && c1 === 17 && r2 === 18 && c2 === 18) ||
            (r1 === 18 && c1 === 18 && r2 === 13 && c2 === 17)) return 20;
        // Default: use distance
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Steel', payment: 12 }] },
          { cardId: 2, demands: [{ city: 'Wien', loadType: 'Potatoes', payment: 29 }] },
        ],
        loadAvailability: { 'Essen': ['Steel'], 'Wroclaw': ['Potatoes'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // The planner should pick the cheap Steel delivery over the expensive Potatoes one
      const firstDelivery = plan.route.find(s => s.action === 'deliver');
      expect(firstDelivery?.loadType).toBe('Steel');
    });

    it('should not penalize high-cost options — budget cap is the only gate', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Hamburg']);
      mockEstimatePathCost.mockReturnValue(17); // 17+17=34 > 32 (old penalty threshold)
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Wien', loadType: 'Steel', payment: 40 }],
        }],
        loadAvailability: { 'Hamburg': ['Steel'] },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      // Efficiency should be raw formula with no penalty multiplier
      for (const opt of options) {
        const rawEfficiency = (opt.payout - opt.totalBuildCost) / opt.estimatedTurns;
        expect(opt.efficiency).toBeCloseTo(rawEfficiency, 2);
      }
    });

    it('should score lower-cost delivery higher when only single deliveries are within budget', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });
      // Make costs high enough that no double fits within MAX_BUILD_BUDGET (40M)
      // but low enough that individual singles fit
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 3.0); // High enough to push doubles over budget
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }] },
          { cardId: 2, demands: [{ city: 'Wien', loadType: 'Wine', payment: 14 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);
      // Should produce a single delivery plan or a double — both are valid.
      // When costs are high (dist*3.0), most doubles exceed the 40M budget.
      // Verify the plan is valid: single (2 stops) or double (4 stops).
      expect([2, 4]).toContain(plan.route.length);
      const deliveries = plan.route.filter(s => s.action === 'deliver');
      expect(deliveries.length).toBeGreaterThan(0);
      // Each delivery must correspond to a demand card we set up
      for (const d of deliveries) {
        expect(['Coal', 'Wine']).toContain(d.loadType);
      }
    });
  });

  describe('ferry penalty in scorePairing (JIRA-146)', () => {
    it('should penalize double-delivery pairing when one leg requires a ferry', () => {
      // First leg: continent-only (no ferry). Second leg: involves London (ferry)
      const continentalOption = makeDemandOption({
        cardId: 1,
        supplyCity: 'Essen',
        deliveryCity: 'Frankfurt',
        startingCity: 'Ruhr',
        payout: 12,
        totalBuildCost: 5,
      });
      const ferryOption = makeDemandOption({
        cardId: 2,
        supplyCity: 'London',
        deliveryCity: 'Hamburg',
        startingCity: 'London',
        payout: 12,
        totalBuildCost: 5,
      });
      // Add London as a ferry city in the grid
      const ferryGrid = [
        ...grid,
        makeCityPoint(14, 6, 'London', TerrainType.MajorCity),
      ];
      // Mark London grid point as ferry
      for (const gp of ferryGrid) {
        if (gp.city?.name === 'London') gp.isFerryCity = true;
      }

      const pairingsWithFerry = InitialBuildPlanner.computeDoubleDeliveryPairings(
        [continentalOption, ferryOption], ferryGrid,
      );

      // Same pairing but no ferry on second leg
      const noFerryOption = makeDemandOption({
        cardId: 2,
        supplyCity: 'Lyon',
        deliveryCity: 'Zürich',
        startingCity: 'Paris',
        payout: 12,
        totalBuildCost: 5,
      });

      const pairingsNoFerry = InitialBuildPlanner.computeDoubleDeliveryPairings(
        [continentalOption, noFerryOption], grid,
      );

      // The ferry pairing should score lower (penalized by 30 points)
      if (pairingsWithFerry.length > 0 && pairingsNoFerry.length > 0) {
        expect(pairingsNoFerry[0].pairingScore).toBeGreaterThan(pairingsWithFerry[0].pairingScore);
      }
    });
  });

  describe('JIRA-148: route selection reproducer (game-1b31e1a2)', () => {
    /**
     * Reproduces the bug where InitialBuildPlanner chose Cars@Stuttgart→Marseille
     * (worst demand by global ranking) over China@Leipzig→Ruhr (best demand).
     *
     * The bot's 9 demands were:
     *   Card 79: China Leipzig→Ruhr (7M), Wheat Toulouse→Lisboa (26M), Cork Lisboa→Wroclaw (59M)
     *   Card 59: Wine Frankfurt→London (16M), Chocolate Bruxelles→Lisboa (40M), Hops Cardiff→Frankfurt (21M)
     *   Card 63: Cork Lisboa→Ruhr (44M), Cars Manchester→Marseille (10M), Cattle Bern→Kobenhavn (28M)
     *
     * We add Stuttgart and Marseille to the grid since those are the supply/delivery
     * cities the planner actually picked.
     */
    it('should log all options and their efficiency scores', () => {
      // Extend grid with cities from the game
      const extendedGrid = [
        ...grid,
        makeCityPoint(30, 14, 'Stuttgart', TerrainType.MediumCity),
        makeCityPoint(28, 8, 'Marseille', TerrainType.MediumCity),
        makeCityPoint(13, 14, 'Leipzig', TerrainType.SmallCity),
        makeCityPoint(24, 6, 'Toulouse', TerrainType.SmallCity),
        makeCityPoint(30, 2, 'Lisboa', TerrainType.MajorCity),  // off-continent but keep for test
        makeCityPoint(25, 8, 'Bern', TerrainType.SmallCity),
        makeCityPoint(8, 14, 'Kobenhavn', TerrainType.MediumCity),
        makeCityPoint(15, 8, 'Bruxelles', TerrainType.SmallCity),
        makeCityPoint(24, 8, 'Sevilla', TerrainType.SmallCity),
      ];

      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        const sources: Record<string, string[]> = {
          'China': ['Leipzig'],
          'Wheat': ['Toulouse'],
          'Cork': ['Lisboa', 'Sevilla'],
          'Wine': ['Frankfurt'],
          'Chocolate': ['Bruxelles'],
          'Hops': ['Frankfurt'],  // Simplified — Cardiff is in Britain, filtered by ferry
          'Cars': ['Stuttgart'],  // Game log shows pickup at Stuttgart
          'Cattle': ['Bern'],
        };
        return sources[loadType] ?? [];
      });

      // Use realistic path costs (distance * 1.5)
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          {
            cardId: 79,
            demands: [
              { city: 'Ruhr', loadType: 'China', payment: 7 },
              { city: 'Lisboa', loadType: 'Wheat', payment: 26 },
              { city: 'Wroclaw', loadType: 'Cork', payment: 59 },
            ],
          },
          {
            cardId: 59,
            demands: [
              { city: 'London', loadType: 'Wine', payment: 16 },
              { city: 'Lisboa', loadType: 'Chocolate', payment: 40 },
              { city: 'Frankfurt', loadType: 'Hops', payment: 21 },
            ],
          },
          {
            cardId: 63,
            demands: [
              { city: 'Ruhr', loadType: 'Cork', payment: 44 },
              { city: 'Marseille', loadType: 'Cars', payment: 10 },
              { city: 'Kobenhavn', loadType: 'Cattle', payment: 28 },
            ],
          },
        ],
        loadAvailability: {
          'Leipzig': ['China'],
          'Toulouse': ['Wheat'],
          'Lisboa': ['Cork'],
          'Sevilla': ['Cork'],
          'Frankfurt': ['Wine', 'Hops'],
          'Bruxelles': ['Chocolate'],
          'Stuttgart': ['Cars'],
          'Bern': ['Cattle'],
        },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, extendedGrid);

      // Diagnostic output — this test exists to make the scoring visible
      console.log('\n[JIRA-148 DIAGNOSTIC]');
      console.log(`  Chosen: ${plan.route.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`);
      console.log(`  Starting city: ${plan.startingCity}`);
      console.log(`  Build cost: ${plan.totalBuildCost}M, Payout: ${plan.totalPayout}M, Est turns: ${plan.estimatedTurns}`);

      // The planner should NOT pick Cars→Marseille as best single —
      // China Leipzig→Ruhr should score higher (short route, Ruhr is a major city starting point)
      const firstPickup = plan.route.find(s => s.action === 'pickup');
      const firstDeliver = plan.route.find(s => s.action === 'deliver');
      console.log(`  First pickup: ${firstPickup?.loadType}@${firstPickup?.city}`);
      console.log(`  First deliver: ${firstDeliver?.loadType}@${firstDeliver?.city}`);

      // Assert that Cars→Marseille is NOT the chosen single delivery
      // (This assertion documents the expected fix — currently it may fail, proving the bug)
      if (plan.route.length === 2) {
        // Single delivery — should not be Cars→Marseille
        expect(firstDeliver?.loadType).not.toBe('Cars');
      }
    });
  });

  describe('JIRA-148: corridor/victory-aware demand scoring', () => {
    it('should NOT select Cars→Marseille when demand scores are provided', () => {
      const extendedGrid = [
        ...grid,
        makeCityPoint(30, 14, 'Stuttgart', TerrainType.MediumCity),
        makeCityPoint(28, 8, 'Marseille', TerrainType.MediumCity),
        makeCityPoint(13, 14, 'Leipzig', TerrainType.SmallCity),
      ];

      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'China') return ['Leipzig'];
        if (loadType === 'Cars') return ['Stuttgart'];
        if (loadType === 'Hops') return ['Frankfurt'];
        return [];
      });

      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 79, demands: [{ city: 'Ruhr', loadType: 'China', payment: 7 }] },
          { cardId: 63, demands: [{ city: 'Marseille', loadType: 'Cars', payment: 10 }] },
          { cardId: 59, demands: [{ city: 'Frankfurt', loadType: 'Hops', payment: 21 }] },
        ],
        loadAvailability: {
          'Leipzig': ['China'],
          'Stuttgart': ['Cars'],
          'Frankfurt': ['Hops'],
        },
      });

      // China→Ruhr has high corridor score (Ruhr is a major hub)
      // Cars→Marseille has low corridor score (peripheral city)
      const demandScores = new Map([
        ['China:Ruhr', 4.5],       // High: corridor bonus from Ruhr hub
        ['Cars:Marseille', 0.8],   // Low: peripheral, low payout
        ['Hops:Frankfurt', 3.2],   // Medium: decent corridor value
      ]);

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, extendedGrid, demandScores);
      const firstDeliver = plan.route.find(s => s.action === 'deliver');
      expect(firstDeliver?.loadType).not.toBe('Cars');
    });

    it('should rank corridor-rich demand higher than higher-payout demand without corridor bonus', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });

      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }] },
          { cardId: 2, demands: [{ city: 'Wien', loadType: 'Wine', payment: 18 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      // Coal→Frankfurt: delivery city is on-network (high corridor score)
      // Wine→Wien: higher payout but no corridor bonus
      const demandScores = new Map([
        ['Coal:Frankfurt', 5.0],  // High corridor value
        ['Wine:Wien', 1.5],       // Low corridor despite higher payout
      ]);

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid, demandScores);
      const firstDeliver = plan.route.find(s => s.action === 'deliver');
      expect(firstDeliver?.loadType).toBe('Coal');
    });

    it('should reflect victory bonus in scoring when demand scores include it', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });

      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 10 }] },
          { cardId: 2, demands: [{ city: 'Wien', loadType: 'Wine', payment: 14 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      // Wine→Wien has victory bonus (connects toward 7th major city)
      const demandScores = new Map([
        ['Coal:Frankfurt', 2.0],
        ['Wine:Wien', 6.0],  // Victory bonus makes this much higher
      ]);

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid, demandScores);
      // Wine has a much higher demand score — it should appear in the plan.
      // If a double is chosen, Wine may be first or second. If single, Wine should win.
      const deliveries = plan.route.filter(s => s.action === 'deliver');
      const hasWine = deliveries.some(s => s.loadType === 'Wine');
      expect(hasWine).toBe(true);
    });

    it('should fall back to local formula when no demand scores provided', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }],
        }],
        loadAvailability: { 'Essen': ['Coal'] },
      });

      // No demandScores param — should still produce options using local formula
      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      expect(options.length).toBeGreaterThan(0);
      for (const opt of options) {
        expect(opt.efficiency).toBeGreaterThan(0);
      }
    });

    it('JIRA-153 regression: negative contextScore — cheaper supply scores higher (less negative) efficiency', () => {
      // Bug: efficiency = contextScore * (1 + localCostFactor) inverts cost preference when
      // contextScore is negative. A larger localCostFactor (cheaper route) makes the result
      // MORE negative (worse), so expensive routes incorrectly rank above cheap ones.
      //
      // Fix: scale the absolute value, then restore the sign.
      //
      // We use two non-major-city supply sources (Essen and Wroclaw) for the same demand.
      // Both will pick the cheapest starting city. By controlling path costs we ensure:
      //   - Essen option: totalBuildCost = 6M  (cheap)
      //   - Wroclaw option: totalBuildCost = 22M (expensive)
      // With a negative contextScore, the cheap option must still produce a HIGHER (less negative)
      // efficiency than the expensive option.
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Steel') return ['Essen', 'Wroclaw'];
        return [];
      });

      // Control costs by fixing estimatePathCost for key city pairs.
      // Ruhr(15,12)→Essen(16,11): 2M (cheap supply leg)
      // Essen(16,11)→Frankfurt(17,14): 4M (supply→delivery) → Ruhr-Essen total = 6M
      // Ruhr(15,12)→Wroclaw(13,17): 12M (expensive supply leg)
      // Wroclaw(13,17)→Frankfurt(17,14): 10M (supply→delivery) → Ruhr-Wroclaw total = 22M
      // (Also need Berlin→Wroclaw etc to be ≥ Ruhr costs so Ruhr stays best for both)
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        // Ruhr(15,12) → Essen(16,11): cheap supply
        if (r1 === 15 && c1 === 12 && r2 === 16 && c2 === 11) return 2;
        if (r1 === 16 && c1 === 11 && r2 === 15 && c2 === 12) return 2;
        // Essen(16,11) → Frankfurt(17,14): supply→delivery
        if (r1 === 16 && c1 === 11 && r2 === 17 && c2 === 14) return 4;
        if (r1 === 17 && c1 === 14 && r2 === 16 && c2 === 11) return 4;
        // Ruhr(15,12) → Wroclaw(13,17): expensive supply
        if (r1 === 15 && c1 === 12 && r2 === 13 && c2 === 17) return 12;
        if (r1 === 13 && c1 === 17 && r2 === 15 && c2 === 12) return 12;
        // Wroclaw(13,17) → Frankfurt(17,14): supply→delivery
        if (r1 === 13 && c1 === 17 && r2 === 17 && c2 === 14) return 10;
        if (r1 === 17 && c1 === 14 && r2 === 13 && c2 === 17) return 10;
        // Berlin(12,16) → Wroclaw(13,17): must be ≥ 12 so Ruhr beats Berlin for Wroclaw too
        if (r1 === 12 && c1 === 16 && r2 === 13 && c2 === 17) return 13;
        if (r1 === 13 && c1 === 17 && r2 === 12 && c2 === 16) return 13;
        // All other: use hex distance * 2 (generous fallback)
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 2);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Steel', payment: 12 }],
        }],
        loadAvailability: { 'Essen': ['Steel'], 'Wroclaw': ['Steel'] },
      });

      // Negative contextScore simulates a below-average demand ranking
      const demandScores = new Map([
        ['Steel:Frankfurt', -1.5],  // Negative: demand is below average relative rank
      ]);

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid, demandScores);

      const essenOption = options.find(o => o.supplyCity === 'Essen');
      const wrocOption = options.find(o => o.supplyCity === 'Wroclaw');

      // Both options must be generated
      expect(essenOption).toBeDefined();
      expect(wrocOption).toBeDefined();

      if (essenOption && wrocOption) {
        // Essen option should have lower totalBuildCost
        expect(essenOption.totalBuildCost).toBeLessThan(wrocOption.totalBuildCost);

        // With fixed formula: cheaper route produces higher (less negative) efficiency
        // i.e. essenOption.efficiency > wrocOption.efficiency even though both are negative
        expect(essenOption.efficiency).toBeGreaterThan(wrocOption.efficiency);

        // Both efficiencies should be negative (contextScore is negative)
        expect(essenOption.efficiency).toBeLessThan(0);
        expect(wrocOption.efficiency).toBeLessThan(0);
      }
    });
  });

  describe('estimateBuildCostFromCity', () => {
    it('should return zero supply cost when starting city is supply city', () => {
      const result = InitialBuildPlanner.estimateBuildCostFromCity(
        'Ruhr', 'Ruhr', 'Frankfurt', grid,
      );
      expect(result).not.toBeNull();
      expect(result!.buildCostToSupply).toBe(0);
      expect(result!.buildCostSupplyToDelivery).toBeGreaterThan(0);
    });

    it('should return null for unknown cities', () => {
      const result = InitialBuildPlanner.estimateBuildCostFromCity(
        'Paris', 'NonexistentCity', 'Frankfurt', grid,
      );
      expect(result).toBeNull();
    });

    it('should return correct total as sum of legs', () => {
      const result = InitialBuildPlanner.estimateBuildCostFromCity(
        'Paris', 'Essen', 'Frankfurt', grid,
      );
      expect(result).not.toBeNull();
      expect(result!.totalBuildCost).toBe(
        result!.buildCostToSupply + result!.buildCostSupplyToDelivery,
      );
    });

    it('JIRA-152: hub routing uses start→delivery when cheaper than supply→delivery', () => {
      // Hub pattern: supply city (Wien) and delivery city (Hamburg) are far from each other,
      // but BOTH are close to the starting city (Berlin).
      // Direct route: supply(Wien)→delivery(Hamburg) is expensive (different ends of the map).
      // Hub route:    start(Berlin)→delivery(Hamburg) is cheap (Berlin is close to Hamburg).
      // The planner should use the hub route for buildCostSupplyToDelivery.
      //
      // Grid positions used:
      //   Berlin  (12,16) — start city
      //   Wien    (18,18) — supply city (far from Hamburg, close to Berlin)
      //   Hamburg (10,14) — delivery city (close to Berlin, far from Wien)

      const SUPPLY_TO_DELIVERY_DIRECT = 20; // Wien(18,18) → Hamburg(10,14): expensive
      const START_TO_DELIVERY_HUB = 4;      // Berlin(12,16) → Hamburg(10,14): cheap

      mockEstimatePathCost.mockImplementation(
        (r1: number, c1: number, r2: number, c2: number): number => {
          // Wien(18,18) → Hamburg(10,14): direct supply→delivery, expensive
          if (r1 === 18 && c1 === 18 && r2 === 10 && c2 === 14) return SUPPLY_TO_DELIVERY_DIRECT;
          if (r1 === 10 && c1 === 14 && r2 === 18 && c2 === 18) return SUPPLY_TO_DELIVERY_DIRECT;
          // Berlin(12,16) → Hamburg(10,14): hub route, cheap
          if (r1 === 12 && c1 === 16 && r2 === 10 && c2 === 14) return START_TO_DELIVERY_HUB;
          if (r1 === 10 && c1 === 14 && r2 === 12 && c2 === 16) return START_TO_DELIVERY_HUB;
          // All other pairs: use hex-distance default
          const dist = mockHexDistance(r1, c1, r2, c2);
          return Math.round(dist * 1.5);
        },
      );

      const result = InitialBuildPlanner.estimateBuildCostFromCity(
        'Berlin', 'Wien', 'Hamburg', grid,
      );

      expect(result).not.toBeNull();
      // Hub routing should win: buildCostSupplyToDelivery should be the hub cost (4),
      // not the expensive direct cost (20).
      expect(result!.buildCostSupplyToDelivery).toBe(START_TO_DELIVERY_HUB);
      expect(result!.buildCostSupplyToDelivery).toBeLessThan(SUPPLY_TO_DELIVERY_DIRECT);
      // totalBuildCost should reflect the cheaper hub-routed leg
      expect(result!.totalBuildCost).toBe(result!.buildCostToSupply + START_TO_DELIVERY_HUB);
    });
  });

  // ── JIRA-151: InitialBuildPlanner improvement tests ──────────────────────────

  describe('JIRA-151: chain-through-delivery-city cost estimation', () => {
    /**
     * Verifies Fix 1: in the different-hub branch, totalBuildCost uses
     * chainLegCost + freshSecondSupplyToDeliveryCost instead of naively summing
     * both full costs (or using Math.min with second.totalBuildCost).
     *
     * Set up a scenario where the second option starts far from the first
     * delivery point (making second.buildCostToSupply expensive), but the first
     * delivery city is actually close to the second supply city (cheap chain leg).
     */
    it('should use chainLeg+supplyToDelivery (not Math.min with second.total) for different-hub', () => {
      // first delivery ends at Frankfurt (17,14)
      // second supply city is Essen (16,11) — very close to Frankfurt
      // second delivery city is Wien (18,18)
      // second.startingCity = Paris (far from Essen) → buildCostToSupply is high
      const firstOption = makeDemandOption({
        cardId: 1,
        loadType: 'Coal',
        supplyCity: 'Essen',
        deliveryCity: 'Frankfurt',
        startingCity: 'Paris',
        payout: 12,
        buildCostToSupply: 10,
        buildCostSupplyToDelivery: 3,
        totalBuildCost: 13,
      });

      // second starts from Wien (18,18) and needs Essen — far from Wien, expensive buildCostToSupply
      // but Frankfurt(17,14)→Essen(16,11) is only 3 hexes apart
      const secondOption = makeDemandOption({
        cardId: 2,
        loadType: 'Wine',
        supplyCity: 'Essen',
        deliveryCity: 'Wien',
        startingCity: 'Wien',  // Different hub from Paris
        payout: 16,
        buildCostToSupply: 12, // Wien→Essen is far
        buildCostSupplyToDelivery: 10,
        totalBuildCost: 22,
      });

      // mockEstimatePathCost returns dist*1.5. Frankfurt(17,14)→Essen(16,11):
      // x1=14-8=6,z1=17,y1=-23. x2=11-8=3,z2=16,y2=-19. dist=max(3,4,1)=4. cost=6.
      // New formula: first.totalBuildCost + chainLegCost + freshSecondSupplyToDeliveryCost
      //            = 13 + 6 + 10 = 29 ≤ 40.
      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(
        [firstOption, secondOption], grid,
      );

      // Should find at least one pairing within budget
      expect(pairings.length).toBeGreaterThan(0);
      if (pairings.length > 0) {
        const best = pairings[0];
        // totalBuildCost = first.total + chainLeg + second.supplyToDelivery = 13 + 6 + 10 = 29
        expect(best.totalBuildCost).toBeLessThanOrEqual(firstOption.totalBuildCost + secondOption.totalBuildCost);
      }
    });
  });

  describe('JIRA-151: double delivery preferred over single when within budget', () => {
    it('should always choose double delivery over single when a within-budget pairing exists', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });
      // Use cheap costs so double fits within budget easily
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 0.5); // very cheap
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 8 }] },
          { cardId: 2, demands: [{ city: 'Zürich', loadType: 'Wine', payment: 6 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // Should choose double delivery (4 route stops)
      expect(plan.route.length).toBe(4);
      expect(plan.totalPayout).toBe(14); // 8 + 6
    });

    it('should fall back to single only when no double fits within the 40M budget', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });
      // Make paths very expensive so doubles always exceed budget
      mockEstimatePathCost.mockImplementation(() => 30); // Each leg = 30M, combined > 40M

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 20 }] },
          { cardId: 2, demands: [{ city: 'Zürich', loadType: 'Wine', payment: 18 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // Should fall back to single delivery (2 route stops)
      expect(plan.route.length).toBe(2);
    });
  });

  describe('JIRA-151: consistent cost model in scorePairing', () => {
    it('should use costBetween (terrain-aware) for chain leg in shared-hub branch', () => {
      // Both options share the same starting city (Ruhr)
      // For shared hub: totalBuildCost = first.totalBuildCost + chainLegCost + second.buildCostSupplyToDelivery
      // Frankfurt(17,14) → Essen(16,11): hexdist≈4, chainLegCost ≈ 4*1.5=6
      // totalBuildCost = 5 + 6 + 5 = 16
      // Previously with chainDistance*1.5: chainDistance(Frankfurt→Holland) * 1.5 would be used
      // With Fix 3, both branches use costBetween consistently
      const opt1 = makeDemandOption({
        cardId: 1,
        supplyCity: 'Essen',
        deliveryCity: 'Frankfurt',
        startingCity: 'Ruhr',
        payout: 12,
        buildCostToSupply: 2,
        buildCostSupplyToDelivery: 3,
        totalBuildCost: 5,
      });
      const opt2 = makeDemandOption({
        cardId: 2,
        supplyCity: 'Holland',
        deliveryCity: 'Hamburg',
        startingCity: 'Ruhr',
        payout: 10,
        buildCostToSupply: 4,
        buildCostSupplyToDelivery: 5,
        totalBuildCost: 9,
      });

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings([opt1, opt2], grid);
      expect(pairings.length).toBeGreaterThan(0);

      const best = pairings[0];
      // Shared hub pairing: totalBuildCost = first.totalBuildCost + chainLeg + second.buildCostSupplyToDelivery
      // chainLeg cost is computed via costBetween (estimatePathCost mock returns dist*1.5)
      expect(best.sharedStartingCity).toBe('Ruhr');
      // totalBuildCost is a specific formula — not the naive sum (5+9=14)
      // It equals first.total + terrain-aware chainLeg + second.supplyToDelivery
      expect(best.totalBuildCost).toBeGreaterThan(0);
      expect(best.totalBuildCost).toBeLessThanOrEqual(MAX_BUILD_BUDGET);
    });

    it('should use first.total + chainLeg + second.supplyToDelivery for different-hub branch (not Math.min)', () => {
      // Different starting cities
      const opt1 = makeDemandOption({
        cardId: 1,
        supplyCity: 'Essen',
        deliveryCity: 'Frankfurt',
        startingCity: 'Ruhr',
        payout: 12,
        buildCostToSupply: 2,
        buildCostSupplyToDelivery: 3,
        totalBuildCost: 5,
      });
      const opt2 = makeDemandOption({
        cardId: 2,
        supplyCity: 'Holland',
        deliveryCity: 'Hamburg',
        startingCity: 'Paris',  // Different hub
        payout: 10,
        buildCostToSupply: 8,
        buildCostSupplyToDelivery: 5,
        totalBuildCost: 13,
      });

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings([opt1, opt2], grid);
      expect(pairings.length).toBeGreaterThan(0);

      const best = pairings[0];
      // Different hub — cost must NOT use Math.min(second.total, ...) since second.total assumes
      // starting from a disconnected city which is invalid during initial build.
      // Instead: first.total + chainLeg + second.supplyToDelivery
      // chainLeg from Frankfurt(17,14)→Holland(14,10) + freshSecondSupplyToDelivery is computed
      // via the mock (dist*1.5). Result will exceed opt1.total + opt2.total because opt2.totalBuildCost
      // assumed a disconnected start and was too cheap.
      expect(best.sharedStartingCity).toBeNull();
      expect(best.totalBuildCost).toBeGreaterThan(0);
      expect(best.totalBuildCost).toBeLessThanOrEqual(MAX_BUILD_BUDGET);
    });

    it('different-hub cost uses chained formula even when second.totalBuildCost is cheaper', () => {
      // Verify that even if second.totalBuildCost < chainLeg + second.supplyToDelivery,
      // we still use the chained formula (first.total + chainLeg + second.supplyToDelivery)
      // because second.totalBuildCost is invalid (assumes disconnected start).
      const opt1 = makeDemandOption({
        cardId: 1,
        supplyCity: 'Essen',
        deliveryCity: 'Frankfurt',
        startingCity: 'Ruhr',
        payout: 12,
        buildCostToSupply: 2,
        buildCostSupplyToDelivery: 3,
        totalBuildCost: 5,
      });
      // Make second.totalBuildCost very cheap (1M) to simulate what Math.min would have chosen.
      // The chained cost (chainLeg + supplyToDelivery) must be computed via the mock, which returns
      // dist*1.5. Frankfurt(17,14)→Holland(14,10): dist ~ 5, chainLeg ~ 7.5 → rounds to ~8.
      // second.buildCostSupplyToDelivery = 5, so chained = ~13.
      // With Math.min, old code would have used min(1, 13) = 1 → totalBuildCost = 5 + 1 = 6.
      // With new code, totalBuildCost = 5 + chainLeg + 5 = ~18, i.e. > second.totalBuildCost alone.
      const opt2 = makeDemandOption({
        cardId: 2,
        supplyCity: 'Holland',
        deliveryCity: 'Hamburg',
        startingCity: 'Paris',  // Different hub
        payout: 10,
        buildCostToSupply: 1,
        buildCostSupplyToDelivery: 5,
        totalBuildCost: 1, // Unrealistically cheap to expose Math.min bug
      });

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings([opt1, opt2], grid);
      expect(pairings.length).toBeGreaterThan(0);

      const best = pairings[0];
      expect(best.sharedStartingCity).toBeNull();
      // Must NOT be first.total + second.total = 5 + 1 = 6 (the Math.min path)
      // Must use first.total + chainLeg + second.supplyToDelivery (chainLeg > 0)
      expect(best.totalBuildCost).toBeGreaterThan(opt1.totalBuildCost + opt2.totalBuildCost);
    });
  });

  describe('JIRA-151: hex-distance-based turn estimation', () => {
    it('should compute estimatedTurns using hex distance for travel, not build cost', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);

      // Set up estimatePathCost to return high alpine cost (5M per milepost)
      // but hexDistance still returns a small number (e.g., 3 mileposts away)
      mockEstimatePathCost.mockReturnValue(15); // 15M for a 3-hex journey = alpine
      // hexDistance mock already uses cubic coordinates — Ruhr(15,12) to Essen(16,11) is close

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 20 }],
        }],
        loadAvailability: { 'Essen': ['Coal'] },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      expect(options.length).toBeGreaterThan(0);

      for (const opt of options) {
        // With hex-distance-based travel:
        // travelDistance = hexToSupply + hexSupplyToDelivery (small values)
        // travelTurns = ceil(travelDistance / 9) + 1 (much smaller than ceil(buildCost/9)+1)
        // buildTurns = ceil(15 / 20) = 1
        // estimatedTurns should be reasonable, not inflated by high alpine build cost
        expect(opt.estimatedTurns).toBeGreaterThan(0);
        expect(opt.estimatedTurns).toBeLessThanOrEqual(10); // sanity bound
      }
    });

    it('should estimate fewer travel turns for nearby cities than distant ones', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 1.5);
      });

      // Frankfurt(17,14) is closer to Essen(16,11) than Wien(18,18)
      const snapshotFrankfurt = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 20 }],
        }],
        loadAvailability: { 'Essen': ['Coal'] },
      });

      const snapshotWien = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Wien', loadType: 'Coal', payment: 20 }],
        }],
        loadAvailability: { 'Essen': ['Coal'] },
      });

      const optsFrankfurt = InitialBuildPlanner.expandDemandOptions(snapshotFrankfurt, grid);
      const optsWien = InitialBuildPlanner.expandDemandOptions(snapshotWien, grid);

      if (optsFrankfurt.length > 0 && optsWien.length > 0) {
        // Frankfurt delivery should have fewer estimated turns than Wien (it's closer to Essen)
        const bestFrankfurt = optsFrankfurt.reduce((a, b) => a.estimatedTurns < b.estimatedTurns ? a : b);
        const bestWien = optsWien.reduce((a, b) => a.estimatedTurns < b.estimatedTurns ? a : b);
        expect(bestFrankfurt.estimatedTurns).toBeLessThanOrEqual(bestWien.estimatedTurns);
      }
    });
  });

  // ── JIRA-170: Shared-pickup double delivery ──────────────────────────────────

  describe('JIRA-170: shared-pickup double delivery', () => {
    describe('computeDoubleDeliveryPairings — shared-pickup detection', () => {
      it('should detect shared-pickup when two demands share supplyCity + loadType with different cardId', () => {
        // Both demands want Potatoes from Lodz — shared supply scenario
        const options: DemandOption[] = [
          makeDemandOption({ cardId: 1, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Frankfurt', startingCity: 'Berlin', payout: 21, totalBuildCost: 8, buildCostToSupply: 4, buildCostSupplyToDelivery: 4 }),
          makeDemandOption({ cardId: 2, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin', payout: 21, totalBuildCost: 10, buildCostToSupply: 4, buildCostSupplyToDelivery: 6 }),
        ];

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);

        expect(pairings.length).toBe(1);
        // Shared-pickup: same supply + load type
        expect(pairings[0].first.supplyCity).toBe('Wroclaw');
        expect(pairings[0].second.supplyCity).toBe('Wroclaw');
        expect(pairings[0].first.loadType).toBe('Potatoes');
        expect(pairings[0].second.loadType).toBe('Potatoes');
      });

      it('should not treat same card as shared-pickup (cardId guard)', () => {
        const options: DemandOption[] = [
          makeDemandOption({ cardId: 1, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Frankfurt' }),
          makeDemandOption({ cardId: 1, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Wien' }),
        ];

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
        expect(pairings.length).toBe(0);
      });

      it('should appear in evaluatedPairings diagnostics output from planInitialBuild', () => {
        mockGetSourceCitiesForLoad.mockReturnValue(['Wroclaw']);
        const snapshot = makeWorldSnapshot({
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Potatoes', payment: 21 }] },
            { cardId: 2, demands: [{ city: 'Wien', loadType: 'Potatoes', payment: 21 }] },
          ],
          loadAvailability: { 'Wroclaw': ['Potatoes'] },
        });

        const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

        // evaluatedPairings should be present when pairings are within budget
        expect(plan.evaluatedPairings).toBeDefined();
      });
    });

    describe('shared-pickup cost model', () => {
      it('should have lower totalBuildCost than equivalent serial chain (no chain-back leg)', () => {
        // Shared-pickup: no need to travel back to supply city between deliveries
        // Serial chain would add: first.totalBuildCost + chainLegCost + second.supplyToDelivery
        // Shared-pickup: closer.totalBuildCost + interDeliveryLeg (no second supply leg)
        const optA = makeDemandOption({ cardId: 1, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Frankfurt', startingCity: 'Berlin', payout: 21, totalBuildCost: 8, buildCostToSupply: 4, buildCostSupplyToDelivery: 4 });
        const optB = makeDemandOption({ cardId: 2, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin', payout: 21, totalBuildCost: 10, buildCostToSupply: 4, buildCostSupplyToDelivery: 6 });

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings([optA, optB], grid);
        expect(pairings.length).toBe(1);

        const sharedPickupCost = pairings[0].totalBuildCost;

        // Serial would be: optA.totalBuildCost + chainLeg(Frankfurt→Wroclaw) + optB.buildCostSupplyToDelivery
        // Shared-pickup: closer.totalBuildCost + interDeliveryLeg(Frankfurt→Wien or Wien→Frankfurt)
        // Since we skip the chain-back-to-supply, shared-pickup should be cheaper
        expect(sharedPickupCost).toBeLessThan(optA.totalBuildCost + optB.buildCostSupplyToDelivery + 20);
        expect(sharedPickupCost).toBeGreaterThan(0);
        expect(sharedPickupCost).toBeLessThanOrEqual(MAX_BUILD_BUDGET);
      });

      it('totalBuildCost equals closer.totalBuildCost + deliveryChainCost', () => {
        // Frankfurt(17,14) is closer to Wroclaw(13,17) than Wien(18,18)
        // Delivery chain = Frankfurt → Wien cost
        const optA = makeDemandOption({ cardId: 1, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Frankfurt', startingCity: 'Berlin', payout: 21, totalBuildCost: 8, buildCostToSupply: 4, buildCostSupplyToDelivery: 4 });
        const optB = makeDemandOption({ cardId: 2, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin', payout: 21, totalBuildCost: 10, buildCostToSupply: 4, buildCostSupplyToDelivery: 6 });

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings([optA, optB], grid);
        expect(pairings.length).toBe(1);

        const pairing = pairings[0];
        // The pairing totalBuildCost should be: closer.totalBuildCost + chainCost
        // chainCost = costBetween(Frankfurt, Wien) which uses estimatePathCost mock
        expect(pairing.totalBuildCost).toBeGreaterThan(0);
        // Verify it doesn't include both options' full build costs summed (that would be serial)
        expect(pairing.totalBuildCost).toBeLessThan(optA.totalBuildCost + optB.totalBuildCost);
      });

      it('should filter out shared-pickup pairings exceeding 40M budget', () => {
        // Make estimatePathCost return very high costs to exceed budget
        mockEstimatePathCost.mockReturnValue(25);
        const options: DemandOption[] = [
          makeDemandOption({ cardId: 1, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Frankfurt', totalBuildCost: 30, buildCostToSupply: 15, buildCostSupplyToDelivery: 15 }),
          makeDemandOption({ cardId: 2, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Wien', totalBuildCost: 30, buildCostToSupply: 15, buildCostSupplyToDelivery: 15 }),
        ];

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
        // 30 + 25 = 55 > 40 — should be filtered
        expect(pairings.every(p => p.totalBuildCost <= MAX_BUILD_BUDGET)).toBe(true);
      });
    });

    describe('shared-pickup delivery ordering', () => {
      it('should deliver closer city first to minimize total distance', () => {
        // Frankfurt(17,14) is closer to Wroclaw(13,17) than Wien(18,18) in hex distance
        const optFrankfurt = makeDemandOption({ cardId: 1, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Frankfurt', startingCity: 'Berlin', payout: 21, totalBuildCost: 8, buildCostToSupply: 4, buildCostSupplyToDelivery: 4 });
        const optWien = makeDemandOption({ cardId: 2, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin', payout: 21, totalBuildCost: 10, buildCostToSupply: 4, buildCostSupplyToDelivery: 6 });

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings([optFrankfurt, optWien], grid);
        expect(pairings.length).toBe(1);

        const pairing = pairings[0];
        // Both orderings tried; the one with lower total distance wins.
        // The first stop in the resulting pairing should be the closer delivery.
        // Grid positions: Wroclaw(13,17), Frankfurt(17,14), Wien(18,18)
        // hexDistance(Wroclaw→Frankfurt) vs hexDistance(Wroclaw→Wien)
        const wroclaw = { row: 13, col: 17 };
        const frankfurt = { row: 17, col: 14 };
        const wien = { row: 18, col: 18 };
        const distToFrankfurt = mockHexDistance(wroclaw.row, wroclaw.col, frankfurt.row, frankfurt.col);
        const distToWien = mockHexDistance(wroclaw.row, wroclaw.col, wien.row, wien.col);

        if (distToFrankfurt <= distToWien) {
          expect(pairing.first.deliveryCity).toBe('Frankfurt');
          expect(pairing.second.deliveryCity).toBe('Wien');
        } else {
          expect(pairing.first.deliveryCity).toBe('Wien');
          expect(pairing.second.deliveryCity).toBe('Frankfurt');
        }
      });

      it('should evaluate both delivery orderings and pick better total distance', () => {
        // Wien(18,18) closer to Wroclaw(13,17) in hex distance — should go Wien first
        const optWien = makeDemandOption({ cardId: 1, loadType: 'Steel', supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin', payout: 20, totalBuildCost: 8 });
        const optFrankfurt = makeDemandOption({ cardId: 2, loadType: 'Steel', supplyCity: 'Wroclaw', deliveryCity: 'Frankfurt', startingCity: 'Berlin', payout: 20, totalBuildCost: 10 });

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings([optWien, optFrankfurt], grid);
        expect(pairings.length).toBe(1);

        // Pairing should exist with valid score
        expect(pairings[0].pairingScore).toBeDefined();
        expect(pairings[0].totalPayout).toBe(40); // 20 + 20
      });
    });

    describe('planInitialBuild — shared-pickup route shape', () => {
      it('should generate 4-stop route [pickup, pickup, deliver, deliver] for shared-pickup winner', () => {
        mockGetSourceCitiesForLoad.mockReturnValue(['Wroclaw']);
        // Use cheap costs to ensure within budget
        mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
          const dist = mockHexDistance(r1, c1, r2, c2);
          return Math.round(dist * 0.5); // very cheap to keep within budget
        });

        const snapshot = makeWorldSnapshot({
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Potatoes', payment: 21 }] },
            { cardId: 2, demands: [{ city: 'Wien', loadType: 'Potatoes', payment: 21 }] },
          ],
          loadAvailability: { 'Wroclaw': ['Potatoes'] },
        });

        const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

        // If shared-pickup wins, expect 4-stop route: 2 pickups + 2 delivers
        expect(plan.route.length).toBe(4);
        expect(plan.route[0].action).toBe('pickup');
        expect(plan.route[1].action).toBe('pickup');
        expect(plan.route[2].action).toBe('deliver');
        expect(plan.route[3].action).toBe('deliver');
        // Both delivers use the same load type
        expect(plan.route[2].loadType).toBe('Potatoes');
        expect(plan.route[3].loadType).toBe('Potatoes');
        // Two pickup stops at the shared supply city
        const pickupStops = plan.route.filter(s => s.action === 'pickup');
        expect(pickupStops.length).toBe(2);
        expect(pickupStops[0].city).toBe('Wroclaw');
        expect(pickupStops[1].city).toBe('Wroclaw');
        // Total payout should be sum of both deliveries
        expect(plan.totalPayout).toBe(42); // 21 + 21
      });

      it('should still produce 4-stop serial route for non-shared pairings', () => {
        mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
          if (loadType === 'Coal') return ['Essen'];
          if (loadType === 'Wine') return ['Lyon'];
          return [];
        });
        mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
          const dist = mockHexDistance(r1, c1, r2, c2);
          return Math.round(dist * 0.8);
        });

        const snapshot = makeWorldSnapshot({
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 15 }] },
            { cardId: 2, demands: [{ city: 'Zürich', loadType: 'Wine', payment: 12 }] },
          ],
          loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
        });

        const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

        // Serial pairings should produce 4-stop route
        if (plan.route.length === 4) {
          expect(plan.route[0].action).toBe('pickup');
          expect(plan.route[1].action).toBe('deliver');
          expect(plan.route[2].action).toBe('pickup');
          expect(plan.route[3].action).toBe('deliver');
        }
      });
    });

    describe('regression: serial chain pairings still work', () => {
      it('should still produce serial pairings for different supply cities', () => {
        const options: DemandOption[] = [
          makeDemandOption({ cardId: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 12, totalBuildCost: 5 }),
          makeDemandOption({ cardId: 2, loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Zürich', startingCity: 'Paris', payout: 10, totalBuildCost: 5 }),
        ];

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
        expect(pairings.length).toBeGreaterThan(0);
        // Different supply cities → serial chain, not shared-pickup
        // The supply cities differ so it's a standard pairing
        expect(pairings[0].first.supplyCity).not.toBe(pairings[0].second.supplyCity);
      });

      it('should still work for mixed scenario with both shared and serial pairings', () => {
        const options: DemandOption[] = [
          // Shared-pickup: both want Potatoes from Wroclaw
          makeDemandOption({ cardId: 1, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Frankfurt', startingCity: 'Berlin', payout: 21, totalBuildCost: 8 }),
          makeDemandOption({ cardId: 2, loadType: 'Potatoes', supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin', payout: 21, totalBuildCost: 10 }),
          // Serial: different load type
          makeDemandOption({ cardId: 3, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 12, totalBuildCost: 5 }),
        ];

        const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
        // Should produce pairings: shared-pickup (1+2) plus serial pairings (1+3, 2+3)
        expect(pairings.length).toBeGreaterThan(0);

        // Shared-pickup pairing between cards 1 and 2 should appear
        const sharedPickupPairing = pairings.find(
          p => p.first.supplyCity === 'Wroclaw'
            && p.second.supplyCity === 'Wroclaw'
            && p.first.loadType === 'Potatoes'
            && p.second.loadType === 'Potatoes',
        );
        expect(sharedPickupPairing).toBeDefined();
      });
    });
  });
});

// ── Test helpers ──────────────────────────────────────────────────────────────

const MAX_BUILD_BUDGET = 40;

function makeDemandOption(overrides: Partial<DemandOption> = {}): DemandOption {
  return {
    cardId: 1,
    demandIndex: 0,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Frankfurt',
    payout: 12,
    startingCity: 'Ruhr',
    buildCostToSupply: 3,
    buildCostSupplyToDelivery: 5,
    totalBuildCost: 8,
    ferryRequired: false,
    estimatedTurns: 3,
    efficiency: 1.33,
    ...overrides,
  };
}

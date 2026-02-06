import { OptionGenerator } from '../services/ai/OptionGenerator';
import { AIActionType } from '../../shared/types/AITypes';
import type { WorldSnapshot, OtherPlayerSnapshot } from '../../shared/types/AITypes';
import { TrainType, TerrainType } from '../../shared/types/GameTypes';
import type { GridPoint } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import type { LoadState } from '../../shared/types/LoadTypes';
import type { DemandCard } from '../../shared/types/DemandCard';

// --- Test helpers ---

function makeGridPoint(row: number, col: number, terrain: TerrainType, cityName?: string): GridPoint {
  return {
    id: `${col},${row}`,
    x: 0,
    y: 0,
    row,
    col,
    terrain,
    ...(cityName && terrain >= TerrainType.SmallCity
      ? { city: { type: terrain, name: cityName, availableLoads: [] } }
      : {}),
    ...(cityName && terrain < TerrainType.SmallCity ? { name: cityName } : {}),
  };
}

function makeDemandCard(id: number, demands: Array<{ city: string; resource: LoadType; payment: number }>): DemandCard {
  return { id, demands };
}

function buildTrackGraph(edges: Array<[string, string]>): ReadonlyMap<string, ReadonlySet<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a)!.add(b);
    graph.get(b)!.add(a);
  }
  return graph as ReadonlyMap<string, ReadonlySet<string>>;
}

function baseSnapshot(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
  const defaultTopology: GridPoint[] = [
    makeGridPoint(10, 15, TerrainType.Clear),
    makeGridPoint(11, 15, TerrainType.Clear),
    makeGridPoint(12, 16, TerrainType.SmallCity, 'Bordeaux'),
    makeGridPoint(20, 25, TerrainType.MajorCity, 'Paris'),
    makeGridPoint(30, 30, TerrainType.MediumCity, 'München'),
    makeGridPoint(40, 35, TerrainType.MajorCity, 'Berlin'),
    makeGridPoint(50, 40, TerrainType.SmallCity, 'Essen'),
  ];

  const defaultGraph = buildTrackGraph([
    ['10,15', '11,15'],
    ['11,15', '12,16'],
  ]);

  const defaultCards: DemandCard[] = [
    makeDemandCard(1, [
      { city: 'Bordeaux', resource: LoadType.Wine, payment: 30 },
      { city: 'Paris', resource: LoadType.Coal, payment: 25 },
      { city: 'Berlin', resource: LoadType.Beer, payment: 20 },
    ]),
    makeDemandCard(2, [
      { city: 'München', resource: LoadType.Cheese, payment: 18 },
      { city: 'Essen', resource: LoadType.Steel, payment: 22 },
      { city: 'Paris', resource: LoadType.Oil, payment: 40 },
    ]),
    makeDemandCard(3, [
      { city: 'Berlin', resource: LoadType.Machinery, payment: 35 },
      { city: 'Bordeaux', resource: LoadType.Oranges, payment: 15 },
      { city: 'München', resource: LoadType.Cars, payment: 28 },
    ]),
  ];

  const defaultLoadStates: LoadState[] = [
    { loadType: 'Wine', availableCount: 4, totalCount: 4, cities: ['Bordeaux'] },
    { loadType: 'Coal', availableCount: 3, totalCount: 3, cities: ['Essen'] },
    { loadType: 'Beer', availableCount: 4, totalCount: 4, cities: ['München'] },
    { loadType: 'Oil', availableCount: 3, totalCount: 3, cities: ['Ploiesti'] },
    { loadType: 'Cheese', availableCount: 3, totalCount: 3, cities: ['Bern'] },
    { loadType: 'Steel', availableCount: 3, totalCount: 3, cities: ['Essen'] },
    { loadType: 'Machinery', availableCount: 2, totalCount: 2, cities: ['Milano'] },
    { loadType: 'Oranges', availableCount: 3, totalCount: 3, cities: ['Valencia'] },
    { loadType: 'Cars', availableCount: 2, totalCount: 2, cities: ['München'] },
  ];

  const majorCityStatus = new Map<string, boolean>([
    ['Paris', false],
    ['Berlin', false],
  ]);

  return {
    botPlayerId: 'bot-1',
    botPosition: { x: 0, y: 0, row: 10, col: 15 },
    trackNetworkGraph: defaultGraph,
    cash: 100,
    demandCards: defaultCards,
    carriedLoads: [],
    trainType: TrainType.Freight,
    otherPlayers: [],
    globalLoadAvailability: defaultLoadStates,
    activeEvents: [],
    mapTopology: defaultTopology,
    majorCityConnectionStatus: majorCityStatus,
    turnNumber: 5,
    snapshotHash: 'test-hash-1234',
    ...overrides,
  };
}

describe('OptionGenerator', () => {
  describe('generate', () => {
    it('always includes a PassTurn option', () => {
      const options = OptionGenerator.generate(baseSnapshot());
      const passOptions = options.filter(o => o.type === AIActionType.PassTurn);
      expect(passOptions.length).toBe(1);
      expect(passOptions[0].feasible).toBe(true);
    });

    it('generates options for all action types', () => {
      const snapshot = baseSnapshot({ carriedLoads: [LoadType.Wine] });
      const options = OptionGenerator.generate(snapshot);
      const types = new Set(options.map(o => o.type));
      expect(types.has(AIActionType.PassTurn)).toBe(true);
      expect(types.has(AIActionType.DeliverLoad)).toBe(true);
      expect(types.has(AIActionType.PickupAndDeliver)).toBe(true);
      expect(types.has(AIActionType.UpgradeTrain)).toBe(true);
    });
  });

  describe('DeliverLoad options', () => {
    it('generates feasible option when carrying a load and city is reachable', () => {
      // Bot at (10,15), carrying Wine, Bordeaux at (12,16) is 2 hops away on track
      const snapshot = baseSnapshot({ carriedLoads: [LoadType.Wine] });
      const options = OptionGenerator.generate(snapshot);

      const deliverWine = options.find(
        o => o.type === AIActionType.DeliverLoad &&
          o.feasible &&
          o.parameters.loadType === LoadType.Wine &&
          o.parameters.destinationCity === 'Bordeaux',
      );
      expect(deliverWine).toBeDefined();
      expect(deliverWine!.parameters.payment).toBe(30);
    });

    it('generates infeasible option when city is not on track network', () => {
      // Bot carrying Coal, Paris at (20,25) is NOT on the track network
      const snapshot = baseSnapshot({ carriedLoads: [LoadType.Coal] });
      const options = OptionGenerator.generate(snapshot);

      const deliverCoal = options.find(
        o => o.type === AIActionType.DeliverLoad &&
          !o.feasible &&
          o.parameters.loadType === LoadType.Coal &&
          o.parameters.destinationCity === 'Paris',
      );
      expect(deliverCoal).toBeDefined();
      expect(deliverCoal!.rejectionReason).toContain('not connected');
    });

    it('does not generate options when not carrying any loads', () => {
      const snapshot = baseSnapshot({ carriedLoads: [] });
      const options = OptionGenerator.generate(snapshot);

      const deliverOptions = options.filter(o => o.type === AIActionType.DeliverLoad);
      expect(deliverOptions.length).toBe(0);
    });

    it('enforces one-demand-per-card by generating separate options per demand', () => {
      // Card 1 has Wine->Bordeaux AND Coal->Paris
      const snapshot = baseSnapshot({ carriedLoads: [LoadType.Wine, LoadType.Coal] });
      const options = OptionGenerator.generate(snapshot);

      const card1Deliveries = options.filter(
        o => o.type === AIActionType.DeliverLoad && o.parameters.demandCardId === 1,
      );
      // Should have separate options for Wine->Bordeaux and Coal->Paris
      expect(card1Deliveries.length).toBeGreaterThanOrEqual(2);
      const wineDelivery = card1Deliveries.find(o => o.parameters.loadType === LoadType.Wine);
      const coalDelivery = card1Deliveries.find(o => o.parameters.loadType === LoadType.Coal);
      expect(wineDelivery).toBeDefined();
      expect(coalDelivery).toBeDefined();
    });
  });

  describe('PickupAndDeliver options', () => {
    it('generates feasible option when load is available and supply city is reachable', () => {
      // Bordeaux is on the track network and supplies Wine
      const snapshot = baseSnapshot();
      const options = OptionGenerator.generate(snapshot);

      const pickupWine = options.find(
        o => o.type === AIActionType.PickupAndDeliver &&
          o.feasible &&
          o.parameters.loadType === LoadType.Wine,
      );
      // Wine supply city is Bordeaux which IS on the track (12,16)
      expect(pickupWine).toBeDefined();
      expect(pickupWine!.parameters.supplyCity).toBe('Bordeaux');
    });

    it('generates infeasible option when load is unavailable', () => {
      const snapshot = baseSnapshot({
        globalLoadAvailability: [
          { loadType: 'Wine', availableCount: 0, totalCount: 4, cities: ['Bordeaux'] },
          { loadType: 'Coal', availableCount: 3, totalCount: 3, cities: ['Essen'] },
          { loadType: 'Beer', availableCount: 4, totalCount: 4, cities: ['München'] },
          { loadType: 'Oil', availableCount: 3, totalCount: 3, cities: ['Ploiesti'] },
          { loadType: 'Cheese', availableCount: 3, totalCount: 3, cities: ['Bern'] },
          { loadType: 'Steel', availableCount: 3, totalCount: 3, cities: ['Essen'] },
          { loadType: 'Machinery', availableCount: 2, totalCount: 2, cities: ['Milano'] },
          { loadType: 'Oranges', availableCount: 3, totalCount: 3, cities: ['Valencia'] },
          { loadType: 'Cars', availableCount: 2, totalCount: 2, cities: ['München'] },
        ],
      });
      const options = OptionGenerator.generate(snapshot);

      const pickupWine = options.find(
        o => o.type === AIActionType.PickupAndDeliver &&
          !o.feasible &&
          o.parameters.loadType === LoadType.Wine,
      );
      expect(pickupWine).toBeDefined();
      expect(pickupWine!.rejectionReason).toContain('available globally');
    });

    it('generates infeasible option when train is at full capacity', () => {
      // Freight carries max 2
      const snapshot = baseSnapshot({
        carriedLoads: [LoadType.Beer, LoadType.Oil],
      });
      const options = OptionGenerator.generate(snapshot);

      const pickupOptions = options.filter(
        o => o.type === AIActionType.PickupAndDeliver && !o.feasible &&
          o.rejectionReason?.includes('full capacity'),
      );
      expect(pickupOptions.length).toBeGreaterThan(0);
    });

    it('skips PickupAndDeliver for loads already being carried', () => {
      // Carrying Wine - should not generate PickupAndDeliver for Wine
      const snapshot = baseSnapshot({ carriedLoads: [LoadType.Wine] });
      const options = OptionGenerator.generate(snapshot);

      const pickupWine = options.filter(
        o => o.type === AIActionType.PickupAndDeliver && o.parameters.loadType === LoadType.Wine,
      );
      expect(pickupWine.length).toBe(0);
    });

    it('generates infeasible option when supply city is not on network', () => {
      // Oil comes from Ploiesti which is not on the network or in topology
      const snapshot = baseSnapshot();
      const options = OptionGenerator.generate(snapshot);

      const pickupOil = options.find(
        o => o.type === AIActionType.PickupAndDeliver &&
          !o.feasible &&
          o.parameters.loadType === LoadType.Oil,
      );
      expect(pickupOil).toBeDefined();
      expect(pickupOil!.rejectionReason).toContain('connected to track network');
    });
  });

  describe('UpgradeTrain options', () => {
    it('generates upgrade options for Freight', () => {
      const snapshot = baseSnapshot({ trainType: TrainType.Freight, cash: 100 });
      const options = OptionGenerator.generate(snapshot);

      const upgradeOptions = options.filter(
        o => o.type === AIActionType.UpgradeTrain && o.feasible,
      );
      // Freight can upgrade to FastFreight or HeavyFreight
      expect(upgradeOptions.length).toBe(2);
      const targets = upgradeOptions.map(o => o.parameters.targetTrainType);
      expect(targets).toContain(TrainType.FastFreight);
      expect(targets).toContain(TrainType.HeavyFreight);
    });

    it('generates infeasible upgrade when cash is insufficient', () => {
      const snapshot = baseSnapshot({ trainType: TrainType.Freight, cash: 10 });
      const options = OptionGenerator.generate(snapshot);

      const upgradeOptions = options.filter(
        o => o.type === AIActionType.UpgradeTrain && !o.feasible,
      );
      expect(upgradeOptions.length).toBe(2); // Both upgrade paths are infeasible
      expect(upgradeOptions[0].rejectionReason).toContain('Insufficient funds');
    });

    it('generates crossgrade option for FastFreight', () => {
      const snapshot = baseSnapshot({ trainType: TrainType.FastFreight, cash: 100 });
      const options = OptionGenerator.generate(snapshot);

      const crossgrade = options.find(
        o => o.type === AIActionType.UpgradeTrain &&
          o.feasible &&
          o.parameters.kind === 'crossgrade',
      );
      expect(crossgrade).toBeDefined();
      expect(crossgrade!.parameters.targetTrainType).toBe(TrainType.HeavyFreight);
      expect(crossgrade!.parameters.cost).toBe(5);
    });

    it('generates no upgrade options for Superfreight', () => {
      const snapshot = baseSnapshot({ trainType: TrainType.Superfreight, cash: 100 });
      const options = OptionGenerator.generate(snapshot);

      const upgradeOptions = options.filter(o => o.type === AIActionType.UpgradeTrain);
      expect(upgradeOptions.length).toBe(0);
    });
  });

  describe('BuildTrack options', () => {
    it('generates BuildTrack options for unconnected demand cities', () => {
      const snapshot = baseSnapshot();
      const options = OptionGenerator.generate(snapshot);

      const buildOptions = options.filter(
        o => o.type === AIActionType.BuildTrack && o.feasible,
      );
      // Should suggest building toward cities not yet on the network
      expect(buildOptions.length).toBeGreaterThan(0);
    });

    it('does not generate BuildTrack for cities already on network', () => {
      const snapshot = baseSnapshot();
      const options = OptionGenerator.generate(snapshot);

      const buildBordeaux = options.find(
        o => o.type === AIActionType.BuildTrack &&
          o.parameters.destination === 'Bordeaux',
      );
      // Bordeaux is at (12,16) which IS on the track network
      expect(buildBordeaux).toBeUndefined();
    });

    it('generates no BuildTrack when cash is 0', () => {
      const snapshot = baseSnapshot({ cash: 0 });
      const options = OptionGenerator.generate(snapshot);

      const buildOptions = options.filter(o => o.type === AIActionType.BuildTrack);
      // With 0 cash, should only get the infeasible "insufficient funds" option
      const infeasible = buildOptions.filter(o => !o.feasible);
      const feasible = buildOptions.filter(o => o.feasible);
      expect(infeasible.length).toBe(1);
      expect(infeasible[0].rejectionReason).toContain('Insufficient funds');
      expect(feasible.length).toBe(0);
    });

    it('generates start-from-major-city option when no track exists', () => {
      const snapshot = baseSnapshot({
        trackNetworkGraph: new Map() as ReadonlyMap<string, ReadonlySet<string>>,
      });
      const options = OptionGenerator.generate(snapshot);

      const startOption = options.find(
        o => o.type === AIActionType.BuildTrack &&
          o.feasible &&
          o.parameters.destination === 'nearest_major_city',
      );
      expect(startOption).toBeDefined();
    });
  });

  describe('BuildTowardMajorCity options', () => {
    it('generates options for unconnected major cities', () => {
      const snapshot = baseSnapshot();
      const options = OptionGenerator.generate(snapshot);

      const majorCityOptions = options.filter(
        o => o.type === AIActionType.BuildTowardMajorCity,
      );
      // Paris and Berlin are not connected
      expect(majorCityOptions.length).toBeGreaterThan(0);
    });

    it('does not generate options for already connected major cities', () => {
      const snapshot = baseSnapshot({
        majorCityConnectionStatus: new Map([
          ['Paris', true],
          ['Berlin', true],
        ]),
      });
      const options = OptionGenerator.generate(snapshot);

      const majorCityOptions = options.filter(
        o => o.type === AIActionType.BuildTowardMajorCity,
      );
      // All major cities connected - no options generated from our test cities
      // (there may be others from getMajorCityGroups() if they're not in our status map)
      const parisOption = majorCityOptions.find(o => o.parameters.majorCity === 'Paris');
      const berlinOption = majorCityOptions.find(o => o.parameters.majorCity === 'Berlin');
      expect(parisOption).toBeUndefined();
      expect(berlinOption).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles bot with no position gracefully', () => {
      const snapshot = baseSnapshot({ botPosition: null });
      const options = OptionGenerator.generate(snapshot);
      // Should still generate some options (BuildTrack, UpgradeTrain, PassTurn)
      expect(options.length).toBeGreaterThan(0);
      const passOption = options.find(o => o.type === AIActionType.PassTurn);
      expect(passOption).toBeDefined();
    });

    it('handles empty track network', () => {
      const snapshot = baseSnapshot({
        trackNetworkGraph: new Map() as ReadonlyMap<string, ReadonlySet<string>>,
        botPosition: null,
      });
      const options = OptionGenerator.generate(snapshot);
      expect(options.length).toBeGreaterThan(0);
    });

    it('handles empty demand cards', () => {
      const snapshot = baseSnapshot({ demandCards: [] });
      const options = OptionGenerator.generate(snapshot);
      // With no demand cards, should still have PassTurn and upgrade options
      const passOption = options.find(o => o.type === AIActionType.PassTurn);
      expect(passOption).toBeDefined();
    });

    it('all options have valid structure', () => {
      const snapshot = baseSnapshot({ carriedLoads: [LoadType.Wine] });
      const options = OptionGenerator.generate(snapshot);

      for (const option of options) {
        expect(option.id).toBeDefined();
        expect(option.id.length).toBeGreaterThan(0);
        expect(typeof option.type).toBe('string');
        expect(typeof option.score).toBe('number');
        expect(typeof option.feasible).toBe('boolean');
        if (!option.feasible) {
          expect(option.rejectionReason).toBeTruthy();
        } else {
          expect(option.rejectionReason).toBeNull();
        }
      }
    });
  });
});

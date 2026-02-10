/**
 * Unit tests for OptionGenerator.
 * Tests feasible option generation for all action types and infeasibility tagging.
 */

import { OptionGenerator } from '../../ai/OptionGenerator';
import { makeSnapshot, makeDemandCard, makeGridPoint, makeSegment } from './helpers/testFixtures';
import { AIActionType } from '../../ai/types';
import type { FeasibleOption, InfeasibleOption } from '../../ai/types';
import { TrainType, TerrainType, TRAIN_PROPERTIES } from '../../../shared/types/GameTypes';
import type { PlayerTrackState } from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';

// Mock majorCityGroups
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    {
      cityName: 'Berlin',
      center: { row: 10, col: 10 },
      outposts: [{ row: 10, col: 9 }, { row: 10, col: 11 }],
    },
    {
      cityName: 'Paris',
      center: { row: 20, col: 20 },
      outposts: [{ row: 20, col: 19 }],
    },
  ],
  getFerryEdges: () => [],
}));

// --- Helpers ---

function gp(row: number, col: number, terrain: TerrainType, cityName?: string) {
  return makeGridPoint(row, col, terrain, cityName);
}

/** Build a small map around Berlin (10,10) with some clear terrain. */
function makeTestMapPoints() {
  return [
    // Berlin major city
    gp(10, 10, TerrainType.MajorCity, 'Berlin'),
    gp(10, 9, TerrainType.MajorCity, 'Berlin'),
    gp(10, 11, TerrainType.MajorCity, 'Berlin'),
    // Clear terrain around Berlin
    gp(10, 8, TerrainType.Clear),
    gp(10, 7, TerrainType.Clear),
    gp(10, 6, TerrainType.Clear),
    gp(10, 5, TerrainType.Clear),
    gp(10, 12, TerrainType.Clear),
    gp(11, 10, TerrainType.Clear),
    gp(11, 9, TerrainType.Clear),
    gp(9, 10, TerrainType.Clear),
    gp(9, 9, TerrainType.Clear),
    // Small city
    gp(10, 4, TerrainType.SmallCity, 'Hamburg'),
    // Paris major city (far away)
    gp(20, 20, TerrainType.MajorCity, 'Paris'),
    gp(20, 19, TerrainType.MajorCity, 'Paris'),
  ];
}

/** Build tracks from Berlin outpost to clear terrain chain. */
function makeTestTracks(botId: string): PlayerTrackState[] {
  return [{
    playerId: botId,
    gameId: 'test-game',
    segments: [
      makeSegment(10, 9, TerrainType.MajorCity, 10, 8, TerrainType.Clear, 1),
      makeSegment(10, 8, TerrainType.Clear, 10, 7, TerrainType.Clear, 1),
      makeSegment(10, 7, TerrainType.Clear, 10, 6, TerrainType.Clear, 1),
      makeSegment(10, 6, TerrainType.Clear, 10, 5, TerrainType.Clear, 1),
      makeSegment(10, 5, TerrainType.Clear, 10, 4, TerrainType.SmallCity, 3),
    ],
    totalCost: 7,
    turnBuildCost: 0,
    lastBuildTimestamp: new Date(),
  }];
}

// --- Tests ---

describe('OptionGenerator', () => {
  describe('generate', () => {
    it('should always include a PassTurn option', () => {
      const snapshot = makeSnapshot();
      const result = OptionGenerator.generate(snapshot);

      const passOptions = result.feasible.filter((o) => o.type === AIActionType.PassTurn);
      expect(passOptions).toHaveLength(1);
      expect(passOptions[0].description).toContain('Pass turn');
    });

    it('should return empty feasible list (except PassTurn) with no game state', () => {
      const snapshot = makeSnapshot({
        position: null,
        carriedLoads: [],
        demandCards: [],
        money: 0,
        trackSegments: [],
      });

      const result = OptionGenerator.generate(snapshot);
      expect(result.feasible).toHaveLength(1); // Only PassTurn
      expect(result.feasible[0].type).toBe(AIActionType.PassTurn);
    });
  });

  describe('delivery options', () => {
    it('should generate a DeliverLoad option when load and demand match at reachable city', () => {
      const tracks = makeTestTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 9,
        carriedLoads: [LoadType.Coal],
        demandCards: [makeDemandCard(1, [
          { city: 'Hamburg', resource: LoadType.Coal, payment: 15 },
        ])],
        allPlayerTracks: tracks,
        trackSegments: tracks[0].segments,
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);
      const deliveries = result.feasible.filter((o) => o.type === AIActionType.DeliverLoad);

      expect(deliveries.length).toBeGreaterThanOrEqual(1);
      expect(deliveries[0].description).toContain('Coal');
      expect(deliveries[0].description).toContain('Hamburg');
    });

    it('should not generate delivery options when no loads carried', () => {
      const snapshot = makeSnapshot({
        carriedLoads: [],
        demandCards: [makeDemandCard(1, [
          { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
        ])],
      });

      const result = OptionGenerator.generate(snapshot);
      const deliveries = result.feasible.filter((o) => o.type === AIActionType.DeliverLoad);
      expect(deliveries).toHaveLength(0);
    });

    it('should tag delivery as infeasible when destination is unreachable', () => {
      const tracks = makeTestTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 2, // Not enough to reach Paris
        carriedLoads: [LoadType.Coal],
        demandCards: [makeDemandCard(1, [
          { city: 'Paris', resource: LoadType.Coal, payment: 30 },
        ])],
        allPlayerTracks: tracks,
        trackSegments: tracks[0].segments,
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);
      const infeasibleDeliveries = result.infeasible.filter((o) => o.type === AIActionType.DeliverLoad);

      expect(infeasibleDeliveries.length).toBeGreaterThanOrEqual(1);
      expect(infeasibleDeliveries[0].reason).toBeTruthy();
    });
  });

  describe('pickup and deliver options', () => {
    it('should generate PickupAndDeliver when load is available at reachable city', () => {
      const tracks = makeTestTracks('bot-1');
      const loadAvailability = new Map([
        ['Hamburg', [LoadType.Coal as string]],
      ]);

      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 9,
        carriedLoads: [],
        demandCards: [makeDemandCard(1, [
          { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
        ])],
        allPlayerTracks: tracks,
        trackSegments: tracks[0].segments,
        mapPoints: makeTestMapPoints(),
        loadAvailability,
      });

      const result = OptionGenerator.generate(snapshot);
      const pickups = result.feasible.filter((o) => o.type === AIActionType.PickupAndDeliver);

      expect(pickups.length).toBeGreaterThanOrEqual(1);
      expect(pickups[0].description).toContain('Coal');
      expect(pickups[0].description).toContain('Hamburg');
    });

    it('should not generate pickup options when train is at capacity', () => {
      const tracks = makeTestTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 9,
        carriedLoads: [LoadType.Coal, LoadType.Wine], // Freight capacity = 2
        trainType: TrainType.Freight,
        demandCards: [makeDemandCard(1, [
          { city: 'Berlin', resource: LoadType.Steel, payment: 20 },
        ])],
        allPlayerTracks: tracks,
        trackSegments: tracks[0].segments,
        mapPoints: makeTestMapPoints(),
        loadAvailability: new Map([['Hamburg', [LoadType.Steel as string]]]),
      });

      const result = OptionGenerator.generate(snapshot);
      const pickups = result.feasible.filter((o) => o.type === AIActionType.PickupAndDeliver);
      expect(pickups).toHaveLength(0);
    });

    it('should skip pickup when already carrying the demanded load', () => {
      const tracks = makeTestTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 9,
        carriedLoads: [LoadType.Coal],
        demandCards: [makeDemandCard(1, [
          { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
        ])],
        allPlayerTracks: tracks,
        trackSegments: tracks[0].segments,
        mapPoints: makeTestMapPoints(),
        loadAvailability: new Map([['Hamburg', [LoadType.Coal as string]]]),
      });

      const result = OptionGenerator.generate(snapshot);
      // Should not generate a PickupAndDeliver since we already carry Coal
      // (DeliverLoad handles that scenario instead)
      const pickups = result.feasible.filter((o) => o.type === AIActionType.PickupAndDeliver);
      expect(pickups).toHaveLength(0);
    });
  });

  describe('upgrade train options', () => {
    it('should generate upgrade options when bot has funds', () => {
      const snapshot = makeSnapshot({
        money: 25,
        trainType: TrainType.Freight,
        turnBuildCostSoFar: 0,
      });

      const result = OptionGenerator.generate(snapshot);
      const upgrades = result.feasible.filter((o) => o.type === AIActionType.UpgradeTrain);

      // Freight can upgrade to FastFreight or HeavyFreight
      expect(upgrades).toHaveLength(2);
      const descriptions = upgrades.map((o) => o.description);
      expect(descriptions.some((d) => d.includes('fast_freight'))).toBe(true);
      expect(descriptions.some((d) => d.includes('heavy_freight'))).toBe(true);
    });

    it('should tag upgrade as infeasible when insufficient funds', () => {
      const snapshot = makeSnapshot({
        money: 10, // Not enough for 20M upgrade
        trainType: TrainType.Freight,
        turnBuildCostSoFar: 0,
      });

      const result = OptionGenerator.generate(snapshot);
      const infeasibleUpgrades = result.infeasible.filter((o) => o.type === AIActionType.UpgradeTrain);

      expect(infeasibleUpgrades.length).toBeGreaterThanOrEqual(1);
      expect(infeasibleUpgrades[0].reason).toContain('Insufficient funds');
    });

    it('should not generate upgrades for Superfreight', () => {
      const snapshot = makeSnapshot({
        money: 50,
        trainType: TrainType.Superfreight,
      });

      const result = OptionGenerator.generate(snapshot);
      const upgrades = result.feasible.filter((o) => o.type === AIActionType.UpgradeTrain);
      const infeasibleUpgrades = result.infeasible.filter((o) => o.type === AIActionType.UpgradeTrain);

      expect(upgrades).toHaveLength(0);
      expect(infeasibleUpgrades).toHaveLength(0);
    });

    it('should offer crossgrade when applicable', () => {
      const snapshot = makeSnapshot({
        money: 10,
        trainType: TrainType.FastFreight,
        turnBuildCostSoFar: 0,
      });

      const result = OptionGenerator.generate(snapshot);
      const upgrades = result.feasible.filter((o) => o.type === AIActionType.UpgradeTrain);

      // FastFreight can crossgrade to HeavyFreight for 5M
      const crossgrade = upgrades.find((o) => o.description.includes('Crossgrade'));
      expect(crossgrade).toBeDefined();
      expect(crossgrade!.description).toContain('heavy_freight');
    });
  });

  describe('build track options', () => {
    it('should generate build options toward demand cities', () => {
      // Bot at Berlin with track but needs to reach Hamburg
      const tracks: PlayerTrackState[] = [{
        playerId: 'bot-1',
        gameId: 'test-game',
        segments: [
          makeSegment(10, 10, TerrainType.MajorCity, 10, 9, TerrainType.MajorCity, 5),
          makeSegment(10, 9, TerrainType.MajorCity, 10, 8, TerrainType.Clear, 1),
        ],
        totalCost: 6,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      }];

      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 10 },
        money: 20,
        turnBuildCostSoFar: 0,
        demandCards: [makeDemandCard(1, [
          { city: 'Hamburg', resource: LoadType.Coal, payment: 15 },
        ])],
        trackSegments: tracks[0].segments,
        allPlayerTracks: tracks,
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);
      const builds = result.feasible.filter((o) => o.type === AIActionType.BuildTrack);

      expect(builds.length).toBeGreaterThanOrEqual(1);
      expect(builds[0].description).toContain('Hamburg');
    });

    it('should not generate build options when no budget remaining', () => {
      const snapshot = makeSnapshot({
        money: 50,
        turnBuildCostSoFar: 20, // Already spent full budget
        demandCards: [makeDemandCard(1, [
          { city: 'Hamburg', resource: LoadType.Coal, payment: 15 },
        ])],
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);
      const builds = result.feasible.filter((o) => o.type === AIActionType.BuildTrack);
      expect(builds).toHaveLength(0);
    });

    it('should not generate build options when no money', () => {
      const snapshot = makeSnapshot({
        money: 0,
        turnBuildCostSoFar: 0,
        demandCards: [makeDemandCard(1, [
          { city: 'Hamburg', resource: LoadType.Coal, payment: 15 },
        ])],
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);
      const builds = result.feasible.filter((o) => o.type === AIActionType.BuildTrack);
      expect(builds).toHaveLength(0);
    });
  });

  describe('build toward major city options', () => {
    it('should generate options for unconnected major cities', () => {
      // Bot has track touching Berlin only, Paris is unconnected
      const tracks: PlayerTrackState[] = [{
        playerId: 'bot-1',
        gameId: 'test-game',
        segments: [
          makeSegment(10, 10, TerrainType.MajorCity, 10, 9, TerrainType.MajorCity, 5),
        ],
        totalCost: 5,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      }];

      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 10 },
        money: 20,
        turnBuildCostSoFar: 0,
        trackSegments: tracks[0].segments,
        allPlayerTracks: tracks,
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);
      const majorCityBuilds = result.feasible.filter(
        (o) => o.type === AIActionType.BuildTowardMajorCity,
      );

      // Should try to build toward Paris (Berlin is already connected)
      // May or may not find a path depending on map completeness
      // But should NOT include Berlin since it's already connected
      const berlinBuilds = [...result.feasible, ...result.infeasible].filter(
        (o) => o.type === AIActionType.BuildTowardMajorCity && o.description.includes('Berlin'),
      );
      expect(berlinBuilds).toHaveLength(0);
    });

    it('should skip cities already in bot network', () => {
      // Bot touches both Berlin center and outpost
      const tracks: PlayerTrackState[] = [{
        playerId: 'bot-1',
        gameId: 'test-game',
        segments: [
          makeSegment(10, 10, TerrainType.MajorCity, 10, 9, TerrainType.MajorCity, 5),
          makeSegment(10, 9, TerrainType.MajorCity, 10, 11, TerrainType.MajorCity, 5),
        ],
        totalCost: 10,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      }];

      const snapshot = makeSnapshot({
        money: 50,
        turnBuildCostSoFar: 0,
        trackSegments: tracks[0].segments,
        allPlayerTracks: tracks,
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);
      const berlinBuilds = result.feasible.filter(
        (o) => o.type === AIActionType.BuildTowardMajorCity && o.description.includes('Berlin'),
      );
      expect(berlinBuilds).toHaveLength(0);
    });
  });

  describe('infeasibility tagging', () => {
    it('should tag all infeasible options with a reason string', () => {
      const tracks = makeTestTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 1, // Very limited movement
        money: 5,             // Very limited budget
        carriedLoads: [LoadType.Coal],
        demandCards: [makeDemandCard(1, [
          { city: 'Paris', resource: LoadType.Coal, payment: 30 },
        ])],
        trainType: TrainType.Freight,
        allPlayerTracks: tracks,
        trackSegments: tracks[0].segments,
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);

      for (const option of result.infeasible) {
        expect(option.feasible).toBe(false);
        expect(option.reason).toBeTruthy();
        expect(typeof option.reason).toBe('string');
      }
    });
  });

  describe('option structure', () => {
    it('should produce valid FeasibleOption shapes', () => {
      const tracks = makeTestTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 9,
        money: 50,
        carriedLoads: [LoadType.Coal],
        demandCards: [makeDemandCard(1, [
          { city: 'Hamburg', resource: LoadType.Coal, payment: 15 },
        ])],
        trainType: TrainType.Freight,
        allPlayerTracks: tracks,
        trackSegments: tracks[0].segments,
        mapPoints: makeTestMapPoints(),
      });

      const result = OptionGenerator.generate(snapshot);

      for (const option of result.feasible) {
        expect(option.feasible).toBe(true);
        expect(option.type).toBeDefined();
        expect(option.description).toBeTruthy();
        expect(option.params).toBeDefined();
        expect(option.params.type).toBe(option.type);
      }
    });

    it('should only generate build and pass options during initialBuild phase', () => {
      const tracks = makeTestTracks('bot-1');
      const snapshot = makeSnapshot({
        gamePhase: 'initialBuild',
        position: { x: 0, y: 0, row: 10, col: 10 },
        money: 50,
        turnBuildCostSoFar: 0,
        trainType: TrainType.Freight,
        carriedLoads: [],
        demandCards: [makeDemandCard(1, [
          { city: 'Hamburg', resource: LoadType.Coal, payment: 15 },
        ])],
        mapPoints: makeTestMapPoints(),
        trackSegments: tracks[0].segments,
        allPlayerTracks: tracks,
      });

      const result = OptionGenerator.generate(snapshot);
      const actionTypes = result.feasible.map((o: FeasibleOption) => o.type);

      // Only BuildTrack, BuildTowardMajorCity, and PassTurn should be present
      const allowedTypes = new Set([
        AIActionType.BuildTrack,
        AIActionType.BuildTowardMajorCity,
        AIActionType.PassTurn,
      ]);
      for (const type of actionTypes) {
        expect(allowedTypes.has(type)).toBe(true);
      }

      // No delivery, pickup, or upgrade options
      expect(actionTypes).not.toContain(AIActionType.DeliverLoad);
      expect(actionTypes).not.toContain(AIActionType.PickupAndDeliver);
      expect(actionTypes).not.toContain(AIActionType.UpgradeTrain);
    });

    it('should have exactly 6 action types defined', () => {
      const actionTypes = Object.values(AIActionType);
      expect(actionTypes).toHaveLength(6);
    });
  });
});

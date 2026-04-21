/**
 * RouteOptimizer.test.ts — Tests for RouteOptimizer.orderStopsByProximity()
 *
 * Migrated from RouteValidator.test.ts:144-784 as part of JIRA-184.
 * Tests the greedy nearest-neighbor stop reordering with pickup-before-delivery
 * constraints and carried-load priority (JIRA-121/123).
 */

import { RouteOptimizer } from '../../services/ai/RouteOptimizer';
import {
  TerrainType,
} from '../../../shared/types/GameTypes';
import { GridPointData } from '../../services/ai/MapTopology';

// Mock MapTopology — estimateHopDistance returns controllable values
const mockGridPoints = new Map<string, GridPointData>();
const mockEstimateHopDistance = jest.fn<number, [number, number, number, number]>(() => 10);
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => mockGridPoints),
  estimateHopDistance: (r1: number, c1: number, r2: number, c2: number) => mockEstimateHopDistance(r1, c1, r2, c2),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

// ── Tests ──────────────────────────────────────────────────────────────

describe('RouteOptimizer', () => {
  beforeEach(() => {
    mockGridPoints.clear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('orderStopsByProximity', () => {
    beforeEach(() => {
      // Set up grid points for test cities
      mockGridPoints.set('10,5', { row: 10, col: 5, terrain: TerrainType.MajorCity, name: 'Essen' });
      mockGridPoints.set('30,20', { row: 30, col: 20, terrain: TerrainType.MajorCity, name: 'Ruhr' });
      mockGridPoints.set('12,7', { row: 12, col: 7, terrain: TerrainType.MajorCity, name: 'Valencia' });
      mockGridPoints.set('25,15', { row: 25, col: 15, terrain: TerrainType.MajorCity, name: 'Berlin' });
      mockGridPoints.set('40,25', { row: 40, col: 25, terrain: TerrainType.MajorCity, name: 'Praha' });
    });

    it('should reorder closer pickup before farther pickup', () => {
      // Bot at Essen (10,5). Valencia (12,7) is closer than Ruhr (30,20).
      mockEstimateHopDistance.mockImplementation(
        (fromRow: number, fromCol: number, toRow: number, toCol: number) => {
          // Essen→Valencia = 3, Essen→Ruhr = 20, Valencia→Ruhr = 18, Ruhr→Berlin = 10, Valencia→Berlin = 15
          if (fromRow === 10 && toRow === 12) return 3;   // Essen→Valencia
          if (fromRow === 10 && toRow === 30) return 20;  // Essen→Ruhr
          if (fromRow === 12 && toRow === 30) return 18;  // Valencia→Ruhr
          if (fromRow === 12 && toRow === 25) return 15;  // Valencia→Berlin
          if (fromRow === 30 && toRow === 25) return 10;  // Ruhr→Berlin
          if (fromRow === 30 && toRow === 12) return 18;  // Ruhr→Valencia
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Steel', city: 'Ruhr' },
        { action: 'deliver' as const, loadType: 'Steel', city: 'Berlin', demandCardId: 1, payment: 15 },
        { action: 'pickup' as const, loadType: 'Oranges', city: 'Valencia' },
        { action: 'deliver' as const, loadType: 'Oranges', city: 'Ruhr', demandCardId: 2, payment: 10 },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
      );

      // Valencia (3 hops) should come before Ruhr (20 hops)
      expect(result[0]).toEqual(expect.objectContaining({ action: 'pickup', city: 'Valencia' }));
      // Oranges deliver at Ruhr should follow Oranges pickup
      const orangesPickupIdx = result.findIndex(s => s.action === 'pickup' && s.loadType === 'Oranges');
      const orangesDeliverIdx = result.findIndex(s => s.action === 'deliver' && s.loadType === 'Oranges');
      expect(orangesPickupIdx).toBeLessThan(orangesDeliverIdx);
    });

    it('should maintain pickup-before-delivery constraint', () => {
      mockEstimateHopDistance.mockImplementation(
        (fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          // Make Berlin (deliver city) closer than Essen (pickup city)
          if (toRow === 25) return 2;  // →Berlin: very close
          if (toRow === 10) return 15; // →Essen: far
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Coal', city: 'Essen' },
        { action: 'deliver' as const, loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 30, col: 20 }, // bot far from both
        mockGridPoints,
      );

      // Even though Berlin is closer, pickup must come before deliver
      expect(result[0]).toEqual(expect.objectContaining({ action: 'pickup', city: 'Essen' }));
      expect(result[1]).toEqual(expect.objectContaining({ action: 'deliver', city: 'Berlin' }));
    });

    it('should return single-stop route unchanged', () => {
      const stops = [
        { action: 'pickup' as const, loadType: 'Coal', city: 'Essen' },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
      );

      expect(result).toEqual(stops);
      expect(result).toHaveLength(1);
    });

    it('should not change already-optimal order', () => {
      mockEstimateHopDistance.mockImplementation(
        (_fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          if (toRow === 10) return 2;  // Essen: closest
          if (toRow === 25) return 5;  // Berlin: second
          return 20;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Coal', city: 'Essen' },
        { action: 'deliver' as const, loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 8, col: 4 }, // near Essen
        mockGridPoints,
      );

      // Order should be unchanged: pickup Essen then deliver Berlin
      expect(result[0]).toBe(stops[0]);
      expect(result[1]).toBe(stops[1]);
    });

    it('should handle same-city pickup and deliver correctly', () => {
      mockEstimateHopDistance.mockImplementation(
        (_fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          if (toRow === 30) return 5;  // Ruhr
          if (toRow === 40) return 20; // Praha
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Steel', city: 'Ruhr' },
        { action: 'deliver' as const, loadType: 'Oranges', city: 'Ruhr', demandCardId: 2, payment: 10 },
        { action: 'deliver' as const, loadType: 'Steel', city: 'Praha', demandCardId: 1, payment: 20 },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
      );

      // Steel pickup must come before Steel deliver
      const steelPickupIdx = result.findIndex(s => s.action === 'pickup' && s.loadType === 'Steel');
      const steelDeliverIdx = result.findIndex(s => s.action === 'deliver' && s.loadType === 'Steel');
      expect(steelPickupIdx).toBeLessThan(steelDeliverIdx);
    });
  });

  // ── JIRA-121 Bug 3: Carried-load delivery priority ──────────────────────────

  describe('JIRA-121 Bug 3: orderStopsByProximity carried-load priority', () => {
    beforeEach(() => {
      mockGridPoints.set('10,5', { row: 10, col: 5, terrain: TerrainType.MajorCity, name: 'Essen' });
      mockGridPoints.set('25,15', { row: 25, col: 15, terrain: TerrainType.MajorCity, name: 'Berlin' });
      mockGridPoints.set('12,7', { row: 12, col: 7, terrain: TerrainType.MajorCity, name: 'Dublin' });
      mockGridPoints.set('30,20', { row: 30, col: 20, terrain: TerrainType.MajorCity, name: 'Bruxelles' });
    });

    it('should NOT prioritize far delivery over nearby pickup (JIRA-123 detour-cost gate)', () => {
      // Bot at Essen (10,5). Bruxelles (30,20) is 3 hops (within NEARBY_PICKUP_THRESHOLD=4).
      // Cheese is on train but Bruxelles pickup is nearby → detour-cost gate prevents delivery promotion.
      mockEstimateHopDistance.mockImplementation(
        (fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          // Dublin is slightly farther than Bruxelles from Essen
          if (fromRow === 10 && toRow === 12) return 5;   // Essen→Dublin
          if (fromRow === 10 && toRow === 30) return 3;   // Essen→Bruxelles (nearby!)
          if (fromRow === 12 && toRow === 30) return 15;  // Dublin→Bruxelles
          if (fromRow === 12 && toRow === 25) return 10;  // Dublin→Berlin
          if (fromRow === 30 && toRow === 25) return 8;   // Bruxelles→Berlin
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Chocolate', city: 'Bruxelles' },
        { action: 'deliver' as const, loadType: 'Cheese', city: 'Dublin', demandCardId: 2, payment: 12 },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
        ['Cheese'],  // Cheese is on the train
      );

      // JIRA-123: Nearby pickup (3 hops) gates carried-load priority → Bruxelles first
      expect(result[0]).toEqual(expect.objectContaining({ action: 'pickup', loadType: 'Chocolate', city: 'Bruxelles' }));
      expect(result[1]).toEqual(expect.objectContaining({ action: 'deliver', loadType: 'Cheese', city: 'Dublin' }));
    });

    it('should maintain original nearest-neighbor behavior when no carried loads', () => {
      mockEstimateHopDistance.mockImplementation(
        (fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          if (fromRow === 10 && toRow === 30) return 3;   // Essen→Bruxelles (closer)
          if (fromRow === 10 && toRow === 12) return 5;   // Essen→Dublin
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Chocolate', city: 'Bruxelles' },
        { action: 'pickup' as const, loadType: 'Cheese', city: 'Dublin' },
      ];

      // Without carriedLoads, nearest-neighbor picks Bruxelles first
      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
      );

      expect(result[0]).toEqual(expect.objectContaining({ city: 'Bruxelles' }));
      expect(result[1]).toEqual(expect.objectContaining({ city: 'Dublin' }));
    });

    it('should allow carried-load delivery without requiring a pickup first', () => {
      // Cheese is already on the train — deliver(Cheese@Dublin) should be eligible
      // even without a pickup(Cheese) in the route
      mockEstimateHopDistance.mockReturnValue(5);

      const stops = [
        { action: 'deliver' as const, loadType: 'Cheese', city: 'Dublin', demandCardId: 2, payment: 12 },
        { action: 'pickup' as const, loadType: 'Chocolate', city: 'Bruxelles' },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
        ['Cheese'],
      );

      // deliver(Cheese@Dublin) should be first — carried load doesn't need pickup
      // (all stops at 5 hops, beyond NEARBY_PICKUP_THRESHOLD=4, so priority fires)
      expect(result[0]).toEqual(expect.objectContaining({ action: 'deliver', loadType: 'Cheese' }));
    });
  });

  // ── JIRA-123: Detour-cost threshold ─────────────────────────────────────────

  describe('JIRA-123: detour-cost threshold gates carried-load priority', () => {
    beforeEach(() => {
      mockGridPoints.set('10,5', { row: 10, col: 5, terrain: TerrainType.MajorCity, name: 'Porto' });
      mockGridPoints.set('12,7', { row: 12, col: 7, terrain: TerrainType.MajorCity, name: 'Lisboa' });
      mockGridPoints.set('40,30', { row: 40, col: 30, terrain: TerrainType.MajorCity, name: 'Venezia' });
      mockGridPoints.set('25,15', { row: 25, col: 15, terrain: TerrainType.MajorCity, name: 'Berlin' });
    });

    it('should NOT promote far delivery when a nearby pickup exists (within 4 hops)', () => {
      // Bot at Porto (10,5). Lisboa pickup is 2 hops away (within threshold).
      // Fish is on train for Venezia delivery (15 hops) — but Lisboa is nearby, grab it first.
      mockEstimateHopDistance.mockImplementation(
        (fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          if (fromRow === 10 && toRow === 12) return 2;   // Porto→Lisboa (nearby!)
          if (fromRow === 10 && toRow === 40) return 15;  // Porto→Venezia (far)
          if (fromRow === 12 && toRow === 40) return 13;  // Lisboa→Venezia
          return 10;
        },
      );

      const stops = [
        { action: 'deliver' as const, loadType: 'Fish', city: 'Venezia', demandCardId: 1, payment: 42 },
        { action: 'pickup' as const, loadType: 'Cork', city: 'Lisboa' },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
        ['Fish'],  // Fish on train
      );

      // Lisboa pickup (2 hops) should come first — detour-cost gate blocks Fish delivery promotion
      expect(result[0]).toEqual(expect.objectContaining({ action: 'pickup', loadType: 'Cork', city: 'Lisboa' }));
      expect(result[1]).toEqual(expect.objectContaining({ action: 'deliver', loadType: 'Fish', city: 'Venezia' }));
    });

    it('should promote carried-load delivery when all pickups are far (beyond 4 hops)', () => {
      // Bot at Porto (10,5). Berlin pickup is 8 hops (beyond threshold).
      // Fish is on train for Venezia delivery (6 hops) — no nearby pickup, so promote delivery.
      mockEstimateHopDistance.mockImplementation(
        (fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          if (fromRow === 10 && toRow === 25) return 8;   // Porto→Berlin (far, beyond threshold)
          if (fromRow === 10 && toRow === 40) return 6;   // Porto→Venezia
          if (fromRow === 40 && toRow === 25) return 10;  // Venezia→Berlin
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Steel', city: 'Berlin' },
        { action: 'deliver' as const, loadType: 'Fish', city: 'Venezia', demandCardId: 1, payment: 42 },
      ];

      const result = RouteOptimizer.orderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
        ['Fish'],  // Fish on train
      );

      // Fish delivery should be first — no nearby pickup to gate the priority
      expect(result[0]).toEqual(expect.objectContaining({ action: 'deliver', loadType: 'Fish', city: 'Venezia' }));
      expect(result[1]).toEqual(expect.objectContaining({ action: 'pickup', loadType: 'Steel', city: 'Berlin' }));
    });
  });
});

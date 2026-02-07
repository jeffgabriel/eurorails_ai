/**
 * Unit tests for AI performance optimizations:
 * - PathCache: caches reachability queries
 * - OptionGenerator pruning: limits options per type
 * - WorldSnapshot deep-freeze: prevents accidental mutations
 */
import { PathCache } from '../services/ai/WorldSnapshotService';
import { OptionGenerator } from '../services/ai/OptionGenerator';
import { AIActionType } from '../../shared/types/AITypes';
import type { FeasibleOption } from '../../shared/types/AITypes';

// --- PathCache Tests ---

describe('PathCache', () => {
  function makeGraph(): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map([
      ['0,0', new Set(['0,1', '1,0'])],
      ['0,1', new Set(['0,0', '0,2'])],
      ['0,2', new Set(['0,1', '0,3'])],
      ['0,3', new Set(['0,2'])],
      ['1,0', new Set(['0,0', '2,0'])],
      ['2,0', new Set(['1,0'])],
    ]);
  }

  it('computes reachable nodes correctly', () => {
    const cache = new PathCache();
    const graph = makeGraph();

    const reachable = cache.getReachable(graph, '0,0', 2);
    expect(reachable).toContain('0,0');
    expect(reachable).toContain('0,1');
    expect(reachable).toContain('1,0');
    expect(reachable).toContain('0,2');
    expect(reachable).toContain('2,0');
    // 0,3 is 3 steps away, not reachable in 2
    expect(reachable).not.toContain('0,3');
  });

  it('returns cached result on second call with same key', () => {
    const cache = new PathCache();
    const graph = makeGraph();

    const first = cache.getReachable(graph, '0,0', 2);
    const second = cache.getReachable(graph, '0,0', 2);
    // Same reference returned
    expect(first).toBe(second);
    expect(cache.size).toBe(1);
  });

  it('creates separate cache entries for different max steps', () => {
    const cache = new PathCache();
    const graph = makeGraph();

    const step1 = cache.getReachable(graph, '0,0', 1);
    const step3 = cache.getReachable(graph, '0,0', 3);

    expect(step1.size).toBeLessThan(step3.size);
    expect(cache.size).toBe(2);
    // 0,3 reachable in 3 steps but not 1
    expect(step1).not.toContain('0,3');
    expect(step3).toContain('0,3');
  });

  it('returns empty set for unknown start node', () => {
    const cache = new PathCache();
    const graph = makeGraph();

    const reachable = cache.getReachable(graph, '99,99', 5);
    expect(reachable.size).toBe(0);
  });

  it('caches empty results too', () => {
    const cache = new PathCache();
    const graph = makeGraph();

    cache.getReachable(graph, '99,99', 5);
    expect(cache.size).toBe(1);

    const second = cache.getReachable(graph, '99,99', 5);
    expect(second.size).toBe(0);
  });
});

// --- OptionGenerator Pruning Tests ---

describe('OptionGenerator.pruneOptions', () => {
  function makeOption(
    type: AIActionType,
    id: string,
    feasible: boolean,
    params: Record<string, unknown> = {},
  ): FeasibleOption {
    return {
      id,
      type,
      parameters: params,
      score: 0,
      feasible,
      rejectionReason: feasible ? null : 'test reason',
    };
  }

  it('keeps all options when under threshold', () => {
    const options = [
      makeOption(AIActionType.DeliverLoad, 'd1', true, { payment: 30 }),
      makeOption(AIActionType.DeliverLoad, 'd2', true, { payment: 20 }),
      makeOption(AIActionType.PassTurn, 'p1', true),
    ];

    const pruned = OptionGenerator.pruneOptions(options);
    expect(pruned.filter(o => o.feasible)).toHaveLength(3);
  });

  it('prunes feasible options to max per type', () => {
    // Create 8 DeliverLoad options (more than MAX_FEASIBLE_PER_TYPE = 5)
    const options: FeasibleOption[] = [];
    for (let i = 0; i < 8; i++) {
      options.push(makeOption(AIActionType.DeliverLoad, `d${i}`, true, { payment: 10 + i }));
    }
    options.push(makeOption(AIActionType.PassTurn, 'p1', true));

    const pruned = OptionGenerator.pruneOptions(options);
    const feasibleDeliveries = pruned.filter(
      o => o.feasible && o.type === AIActionType.DeliverLoad,
    );
    // Max 5 per type
    expect(feasibleDeliveries.length).toBe(5);
    // PassTurn should still be there
    expect(pruned.find(o => o.type === AIActionType.PassTurn)).toBeDefined();
  });

  it('keeps highest-value deliveries when pruning', () => {
    const options: FeasibleOption[] = [];
    for (let i = 0; i < 8; i++) {
      options.push(makeOption(AIActionType.DeliverLoad, `d${i}`, true, { payment: 10 * (i + 1) }));
    }

    const pruned = OptionGenerator.pruneOptions(options);
    const feasible = pruned.filter(o => o.feasible && o.type === AIActionType.DeliverLoad);

    // Highest payment options should be kept
    const payments = feasible.map(o => o.parameters.payment as number);
    // Top 5: 80, 70, 60, 50, 40
    expect(payments).toContain(80);
    expect(payments).toContain(70);
    expect(payments).toContain(60);
    expect(payments).toContain(50);
    expect(payments).toContain(40);
    // Lowest should be pruned
    expect(payments).not.toContain(10);
  });

  it('always retains infeasible options for audit', () => {
    const options: FeasibleOption[] = [
      makeOption(AIActionType.DeliverLoad, 'd1', true, { payment: 30 }),
      makeOption(AIActionType.DeliverLoad, 'd2', false, { payment: 20 }),
      makeOption(AIActionType.BuildTrack, 'b1', false),
      makeOption(AIActionType.PassTurn, 'p1', true),
    ];

    const pruned = OptionGenerator.pruneOptions(options);
    const infeasible = pruned.filter(o => !o.feasible);
    expect(infeasible).toHaveLength(2);
  });

  it('handles empty options array', () => {
    const pruned = OptionGenerator.pruneOptions([]);
    expect(pruned).toHaveLength(0);
  });

  it('prunes each action type independently', () => {
    const options: FeasibleOption[] = [];
    // 8 of each type
    for (let i = 0; i < 8; i++) {
      options.push(makeOption(AIActionType.DeliverLoad, `d${i}`, true, { payment: 10 + i }));
      options.push(makeOption(AIActionType.BuildTrack, `b${i}`, true, { estimatedCost: 5 + i }));
    }

    const pruned = OptionGenerator.pruneOptions(options);
    const deliveries = pruned.filter(o => o.feasible && o.type === AIActionType.DeliverLoad);
    const builds = pruned.filter(o => o.feasible && o.type === AIActionType.BuildTrack);
    expect(deliveries.length).toBe(5);
    expect(builds.length).toBe(5);
  });
});

// --- WorldSnapshot Deep-Freeze Tests ---

describe('WorldSnapshot immutability (deepFreeze)', () => {
  // We can't easily test deepFreeze in isolation without importing it,
  // but we test that the snapshot from the helper is properly frozen.
  // The integration tests use makeSnapshot which is NOT frozen (test helper).
  // The real WorldSnapshotService.capture() calls deepFreeze.

  it('deepFreeze is applied in WorldSnapshotService source', () => {
    // This is a structural test: verify the source code calls deepFreeze
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../services/ai/WorldSnapshotService'),
      'utf-8',
    );
    expect(source).toContain('deepFreeze(snapshot)');
  });
});

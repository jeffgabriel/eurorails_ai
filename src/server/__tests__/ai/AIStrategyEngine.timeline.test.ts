import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { AIActionType, TurnPlan } from '../../../shared/types/GameTypes';

describe('buildActionTimeline', () => {
  it('returns empty array for empty steps', () => {
    const result = AIStrategyEngine.buildActionTimeline([]);
    expect(result).toEqual([]);
  });

  it('builds timeline for a single move step', () => {
    const steps: TurnPlan[] = [
      {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 5 }, { row: 10, col: 6 }, { row: 11, col: 6 }],
        fees: new Set(),
        totalFee: 0,
      },
    ];
    const result = AIStrategyEngine.buildActionTimeline(steps);
    expect(result).toEqual([
      {
        type: 'move',
        path: [{ row: 10, col: 5 }, { row: 10, col: 6 }, { row: 11, col: 6 }],
      },
    ]);
  });

  it('builds timeline for move → deliver → move sequence', () => {
    const steps: TurnPlan[] = [
      {
        type: AIActionType.MoveTrain,
        path: [{ row: 5, col: 3 }, { row: 5, col: 4 }, { row: 6, col: 4 }],
        fees: new Set(),
        totalFee: 0,
      },
      {
        type: AIActionType.DeliverLoad,
        load: 'Steel',
        city: 'Frankfurt',
        cardId: 42,
        payout: 15,
      },
      {
        type: AIActionType.MoveTrain,
        path: [{ row: 6, col: 4 }, { row: 7, col: 5 }, { row: 8, col: 5 }],
        fees: new Set(),
        totalFee: 0,
      },
    ];
    const result = AIStrategyEngine.buildActionTimeline(steps);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      type: 'move',
      path: [{ row: 5, col: 3 }, { row: 5, col: 4 }, { row: 6, col: 4 }],
    });
    expect(result[1]).toEqual({
      type: 'deliver',
      loadType: 'Steel',
      city: 'Frankfurt',
      payment: 15,
      cardId: 42,
    });
    expect(result[2]).toEqual({
      type: 'move',
      path: [{ row: 6, col: 4 }, { row: 7, col: 5 }, { row: 8, col: 5 }],
    });
  });

  it('builds timeline for move → pickup continuation', () => {
    const steps: TurnPlan[] = [
      {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 1 }, { row: 1, col: 2 }],
        fees: new Set(),
        totalFee: 0,
      },
      {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'Essen',
      },
    ];
    const result = AIStrategyEngine.buildActionTimeline(steps);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('move');
    expect(result[1]).toEqual({
      type: 'pickup',
      loadType: 'Coal',
      city: 'Essen',
    });
  });

  it('builds timeline for build-only turn', () => {
    const steps: TurnPlan[] = [
      {
        type: AIActionType.BuildTrack,
        segments: [
          { from: { row: 1, col: 1 }, to: { row: 1, col: 2 } },
          { from: { row: 1, col: 2 }, to: { row: 2, col: 2 } },
        ] as any,
        targetCity: 'Berlin',
      },
    ];
    const result = AIStrategyEngine.buildActionTimeline(steps);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'build',
      segmentsBuilt: 2,
      cost: 0,
    });
  });

  it('builds timeline for discard turn', () => {
    const steps: TurnPlan[] = [
      { type: AIActionType.DiscardHand },
    ];
    const result = AIStrategyEngine.buildActionTimeline(steps);
    expect(result).toEqual([{ type: 'discard' }]);
  });

  it('builds timeline for upgrade turn', () => {
    const steps: TurnPlan[] = [
      {
        type: AIActionType.UpgradeTrain,
        targetTrain: 'fast_freight',
        cost: 20,
      },
    ];
    const result = AIStrategyEngine.buildActionTimeline(steps);
    expect(result).toEqual([{
      type: 'upgrade',
      trainType: 'fast_freight',
    }]);
  });

  it('skips PassTurn and DropLoad steps', () => {
    const steps: TurnPlan[] = [
      { type: AIActionType.PassTurn },
      { type: AIActionType.DropLoad, load: 'Oil', city: 'Hamburg' } as any,
    ];
    const result = AIStrategyEngine.buildActionTimeline(steps);
    expect(result).toEqual([]);
  });

  it('preserves action ordering in complex multi-action turn', () => {
    const steps: TurnPlan[] = [
      {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 1 }, { row: 1, col: 2 }],
        fees: new Set(),
        totalFee: 0,
      },
      { type: AIActionType.PickupLoad, load: 'Wine', city: 'Bordeaux' } as any,
      {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 2 }, { row: 2, col: 3 }],
        fees: new Set(),
        totalFee: 0,
      },
      {
        type: AIActionType.DeliverLoad,
        load: 'Wine',
        city: 'Paris',
        cardId: 10,
        payout: 20,
      },
      {
        type: AIActionType.MoveTrain,
        path: [{ row: 2, col: 3 }, { row: 3, col: 3 }],
        fees: new Set(),
        totalFee: 0,
      },
    ];
    const result = AIStrategyEngine.buildActionTimeline(steps);
    expect(result).toHaveLength(5);
    expect(result.map(s => s.type)).toEqual(['move', 'pickup', 'move', 'deliver', 'move']);
  });
});

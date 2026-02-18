import { GuardrailEnforcer } from '../../services/ai/GuardrailEnforcer';
import {
  FeasibleOption,
  AIActionType,
  WorldSnapshot,
  TerrainType,
} from '../../../shared/types/GameTypes';

function makeSnapshot(money: number = 50): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money,
      position: null,
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeMoveOption(overrides?: Partial<FeasibleOption>): FeasibleOption {
  return {
    action: AIActionType.MoveTrain,
    feasible: true,
    reason: 'Move toward city',
    ...overrides,
  };
}

function makeBuildOption(overrides?: Partial<FeasibleOption>): FeasibleOption {
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: 'Build track',
    estimatedCost: 5,
    ...overrides,
  };
}

function makePassOption(): FeasibleOption {
  return {
    action: AIActionType.PassTurn,
    feasible: true,
    reason: 'Pass',
    estimatedCost: 0,
  };
}

describe('GuardrailEnforcer', () => {
  describe('Rule 1: Delivery move override', () => {
    it('should override when LLM skips movement but delivery move available', () => {
      const deliveryMove = makeMoveOption({ payment: 12, feasible: true });
      const regularMove = makeMoveOption({ payment: 0 });
      const allMoves = [regularMove, deliveryMove];
      const buildOption = makeBuildOption();

      const result = GuardrailEnforcer.check(
        undefined, // selectedMove = none (LLM skipped)
        buildOption,
        allMoves,
        [buildOption],
        makeSnapshot(),
      );

      expect(result.moveOverridden).toBe(true);
      expect(result.correctedMoveIndex).toBe(1); // deliveryMove is at index 1
      expect(result.reason).toContain('deliverable load');
    });

    it('should NOT override when LLM selected a move', () => {
      const selectedMove = makeMoveOption({ payment: 0 });
      const deliveryMove = makeMoveOption({ payment: 12 });
      const allMoves = [selectedMove, deliveryMove];
      const buildOption = makeBuildOption();

      const result = GuardrailEnforcer.check(
        selectedMove,
        buildOption,
        allMoves,
        [buildOption],
        makeSnapshot(),
      );

      expect(result.moveOverridden).toBe(false);
    });

    it('should NOT override when no delivery moves exist', () => {
      const regularMove = makeMoveOption({ payment: 0 });
      const allMoves = [regularMove];
      const buildOption = makeBuildOption();

      const result = GuardrailEnforcer.check(
        undefined,
        buildOption,
        allMoves,
        [buildOption],
        makeSnapshot(),
      );

      expect(result.moveOverridden).toBe(false);
    });
  });

  describe('Rule 2: Bankruptcy prevention', () => {
    it('should override build that would leave money below 5M', () => {
      const snapshot = makeSnapshot(10); // 10M cash
      const expensiveBuild = makeBuildOption({ estimatedCost: 8 }); // 10-8=2 < 5
      const cheapBuild = makeBuildOption({ estimatedCost: 2 }); // 10-2=8 >= 5
      const allBuilds = [expensiveBuild, cheapBuild];

      const result = GuardrailEnforcer.check(
        undefined,
        expensiveBuild,
        [],
        allBuilds,
        snapshot,
      );

      expect(result.buildOverridden).toBe(true);
      expect(result.correctedBuildIndex).toBe(1); // cheapBuild at index 1
      expect(result.reason).toContain('below 5M');
    });

    it('should NOT override build that leaves sufficient money', () => {
      const snapshot = makeSnapshot(50);
      const build = makeBuildOption({ estimatedCost: 10 }); // 50-10=40 >= 5

      const result = GuardrailEnforcer.check(
        undefined,
        build,
        [],
        [build],
        snapshot,
      );

      expect(result.buildOverridden).toBe(false);
    });

    it('should account for move cost when checking bankruptcy', () => {
      const snapshot = makeSnapshot(15);
      const selectedMove = makeMoveOption({ estimatedCost: 4 }); // usage fee
      // After move: 15 - 4 = 11. Build cost 8: 11-8=3 < 5.
      const build = makeBuildOption({ estimatedCost: 8 });
      const cheapBuild = makeBuildOption({ estimatedCost: 2 });

      const result = GuardrailEnforcer.check(
        selectedMove,
        build,
        [selectedMove],
        [build, cheapBuild],
        snapshot,
      );

      expect(result.buildOverridden).toBe(true);
      expect(result.correctedBuildIndex).toBe(1);
    });
  });

  describe('Rule 3: Discard hand override', () => {
    it('should override DiscardHand when BuildTrack options exist', () => {
      const discardOption: FeasibleOption = {
        action: AIActionType.DiscardHand,
        feasible: true,
        reason: 'Discard',
      };
      const buildOption = makeBuildOption();
      const allBuilds = [discardOption, buildOption];

      const result = GuardrailEnforcer.check(
        undefined,
        discardOption,
        [],
        allBuilds,
        makeSnapshot(),
      );

      expect(result.buildOverridden).toBe(true);
      expect(result.correctedBuildIndex).toBe(1); // buildOption at index 1
      expect(result.reason).toContain('DiscardHand overridden');
    });

    it('should NOT override DiscardHand when no BuildTrack options exist', () => {
      const discardOption: FeasibleOption = {
        action: AIActionType.DiscardHand,
        feasible: true,
        reason: 'Discard',
      };
      const passOption = makePassOption();

      const result = GuardrailEnforcer.check(
        undefined,
        discardOption,
        [],
        [discardOption, passOption],
        makeSnapshot(),
      );

      expect(result.buildOverridden).toBe(false);
    });
  });

  describe('Rule 4: Discard last resort — protect track investment', () => {
    it('should override DiscardHand to PassTurn when bot has track', () => {
      const discardOption: FeasibleOption = {
        action: AIActionType.DiscardHand,
        feasible: true,
        reason: 'Discard',
      };
      const passOption = makePassOption();
      const snapshotWithTrack = makeSnapshot(15);
      snapshotWithTrack.bot.existingSegments = [
        { from: { x: 0, y: 0, row: 10, col: 10, terrain: TerrainType.Clear }, to: { x: 0, y: 0, row: 10, col: 11, terrain: TerrainType.Clear }, cost: 1 },
      ];

      const result = GuardrailEnforcer.check(
        undefined,
        discardOption,
        [],
        [discardOption, passOption],
        snapshotWithTrack,
      );

      expect(result.buildOverridden).toBe(true);
      expect(result.correctedBuildIndex).toBe(1); // passOption at index 1
      expect(result.reason).toContain('track investment');
    });

    it('should NOT override DiscardHand when bot has no track', () => {
      const discardOption: FeasibleOption = {
        action: AIActionType.DiscardHand,
        feasible: true,
        reason: 'Discard',
      };
      const passOption = makePassOption();

      const result = GuardrailEnforcer.check(
        undefined,
        discardOption,
        [],
        [discardOption, passOption],
        makeSnapshot(50), // No track built
      );

      expect(result.buildOverridden).toBe(false);
    });

    it('should prefer Rule 3 (BuildTrack override) over Rule 4 (PassTurn)', () => {
      const discardOption: FeasibleOption = {
        action: AIActionType.DiscardHand,
        feasible: true,
        reason: 'Discard',
      };
      const buildOption = makeBuildOption();
      const passOption = makePassOption();
      const snapshotWithTrack = makeSnapshot(15);
      snapshotWithTrack.bot.existingSegments = [
        { from: { x: 0, y: 0, row: 10, col: 10, terrain: TerrainType.Clear }, to: { x: 0, y: 0, row: 10, col: 11, terrain: TerrainType.Clear }, cost: 1 },
      ];

      const result = GuardrailEnforcer.check(
        undefined,
        discardOption,
        [],
        [discardOption, buildOption, passOption],
        snapshotWithTrack,
      );

      expect(result.buildOverridden).toBe(true);
      expect(result.correctedBuildIndex).toBe(1); // buildOption (Rule 3 takes priority)
      expect(result.reason).toContain('buildable track available');
    });
  });

  describe('No override scenarios', () => {
    it('should return all false when no guardrails trigger', () => {
      const move = makeMoveOption();
      const build = makeBuildOption({ estimatedCost: 5 });

      const result = GuardrailEnforcer.check(
        move,
        build,
        [move],
        [build],
        makeSnapshot(50),
      );

      expect(result.moveOverridden).toBe(false);
      expect(result.buildOverridden).toBe(false);
      expect(result.correctedMoveIndex).toBeUndefined();
      expect(result.correctedBuildIndex).toBeUndefined();
      expect(result.reason).toBeUndefined();
    });
  });
});

import { mergeServerPlayerState } from '../services/mergeServerPlayerState';
import { Player, TrainState, TrainType } from '../../shared/types/GameTypes';

function makeTrainState(overrides: Partial<TrainState> = {}): TrainState {
  return {
    position: null,
    remainingMovement: 9,
    movementHistory: [],
    loads: [],
    ...overrides,
  };
}

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'p1',
    name: 'Alice',
    color: '#ff0000',
    money: 50,
    trainType: TrainType.Freight,
    turnNumber: 1,
    trainState: makeTrainState(),
    hand: [],
    ...overrides,
  };
}

const position = (row: number, col: number) => ({ x: row * 10, y: col * 10, row, col });

describe('mergeServerPlayerState', () => {
  describe('non-local player', () => {
    it('spread-merges with server fields winning', () => {
      const local = makePlayer({ money: 10, turnNumber: 2 });
      const server = makePlayer({ money: 75, turnNumber: 3 });

      const merged = mergeServerPlayerState(local, server, false);

      expect(merged.money).toBe(75);
      expect(merged.turnNumber).toBe(3);
    });

    it('takes server trainState wholesale when present', () => {
      const local = makePlayer({
        trainState: makeTrainState({ position: position(1, 1), remainingMovement: 4 }),
      });
      const serverTrainState = makeTrainState({ position: position(5, 5), remainingMovement: 9 });
      const server = makePlayer({ trainState: serverTrainState });

      const merged = mergeServerPlayerState(local, server, false);

      expect(merged.trainState).toBe(serverTrainState);
    });

    it('keeps local trainState when the server row omits it (partial patch rows)', () => {
      const localTrainState = makeTrainState({ position: position(2, 3) });
      const local = makePlayer({ trainState: localTrainState });
      const server = makePlayer({ trainState: undefined as unknown as TrainState });

      const merged = mergeServerPlayerState(local, server, false);

      expect(merged.trainState).toBe(localTrainState);
    });
  });

  describe('local player', () => {
    it('preserves local position when set', () => {
      const local = makePlayer({ trainState: makeTrainState({ position: position(2, 2) }) });
      const server = makePlayer({ trainState: makeTrainState({ position: position(9, 9) }) });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState.position).toEqual(position(2, 2));
    });

    it('falls back to server position when local position is null', () => {
      const local = makePlayer({ trainState: makeTrainState({ position: null }) });
      const server = makePlayer({ trainState: makeTrainState({ position: position(9, 9) }) });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState.position).toEqual(position(9, 9));
    });

    it('preserves non-empty local movementHistory', () => {
      const history = [{ from: position(1, 1), to: position(1, 2), cost: 1 }] as unknown as TrainState['movementHistory'];
      const local = makePlayer({ trainState: makeTrainState({ movementHistory: history }) });
      const server = makePlayer({ trainState: makeTrainState({ movementHistory: [] }) });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState.movementHistory).toBe(history);
    });

    it('takes server movementHistory when local history is empty', () => {
      const serverHistory = [{ from: position(3, 3), to: position(3, 4), cost: 1 }] as unknown as TrainState['movementHistory'];
      const local = makePlayer({ trainState: makeTrainState({ movementHistory: [] }) });
      const server = makePlayer({ trainState: makeTrainState({ movementHistory: serverHistory }) });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState.movementHistory).toBe(serverHistory);
    });

    it('preserves numeric local remainingMovement including 0', () => {
      const local = makePlayer({ trainState: makeTrainState({ remainingMovement: 0 }) });
      const server = makePlayer({ trainState: makeTrainState({ remainingMovement: 12 }) });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState.remainingMovement).toBe(0);
    });

    it('takes server remainingMovement when local is undefined', () => {
      const local = makePlayer({
        trainState: makeTrainState({ remainingMovement: undefined as unknown as number }),
      });
      const server = makePlayer({ trainState: makeTrainState({ remainingMovement: 12 }) });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState.remainingMovement).toBe(12);
    });

    it('prefers local ferryState and justCrossedFerry', () => {
      const ferryState = {
        status: 'ready_to_cross',
        ferryConnection: {},
        currentSide: { row: 1, col: 1 },
        otherSide: { row: 2, col: 2 },
      } as unknown as TrainState['ferryState'];
      const local = makePlayer({
        trainState: makeTrainState({ ferryState, justCrossedFerry: true }),
      });
      const server = makePlayer({ trainState: makeTrainState() });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState.ferryState).toBe(ferryState);
      expect(merged.trainState.justCrossedFerry).toBe(true);
    });

    it('falls back to server ferry fields when local has none', () => {
      const serverFerryState = {
        status: 'just_arrived',
        ferryConnection: {},
        currentSide: { row: 4, col: 4 },
        otherSide: { row: 5, col: 5 },
      } as unknown as TrainState['ferryState'];
      const local = makePlayer({ trainState: makeTrainState() });
      const server = makePlayer({
        trainState: makeTrainState({ ferryState: serverFerryState, justCrossedFerry: false }),
      });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState.ferryState).toBe(serverFerryState);
      expect(merged.trainState.justCrossedFerry).toBe(false);
    });

    it('takes server hand when provided (issue #176)', () => {
      const serverHand = [{ id: 1 }] as unknown as Player['hand'];
      const localHand = [{ id: 2 }] as unknown as Player['hand'];
      const local = makePlayer({ hand: localHand });
      const server = makePlayer({ hand: serverHand });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.hand).toBe(serverHand);
    });

    it('keeps local hand when server omits it', () => {
      const localHand = [{ id: 2 }] as unknown as Player['hand'];
      const local = makePlayer({ hand: localHand });
      const server = makePlayer({ hand: undefined as unknown as Player['hand'] });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.hand).toBe(localHand);
    });

    it('takes server trainState wholesale when local has none', () => {
      const serverTrainState = makeTrainState({ position: position(7, 7) });
      const local = makePlayer({ trainState: undefined as unknown as TrainState });
      const server = makePlayer({ trainState: serverTrainState });

      const merged = mergeServerPlayerState(local, server, true);

      expect(merged.trainState).toBe(serverTrainState);
    });
  });

  it('does not mutate its inputs', () => {
    const local = makePlayer({ trainState: makeTrainState({ position: position(1, 1) }) });
    const server = makePlayer({ money: 99, trainState: makeTrainState({ position: position(2, 2) }) });
    const localSnapshot = JSON.parse(JSON.stringify(local));
    const serverSnapshot = JSON.parse(JSON.stringify(server));

    mergeServerPlayerState(local, server, true);

    expect(JSON.parse(JSON.stringify(local))).toEqual(localSnapshot);
    expect(JSON.parse(JSON.stringify(server))).toEqual(serverSnapshot);
  });
});

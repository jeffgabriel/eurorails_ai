import type { PoolClient } from 'pg';
import {
  assertUserTurn,
  lockPlayerForUserTurn,
  TurnGuardError,
  TurnGuardErrorCode,
} from '../services/turnGuard';

jest.mock('../db/index', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    db: {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn(),
    },
    __mockClient: mockClient,
  };
});

const { __mockClient: pooledClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

const gameId = 'game-1';
const userId = 'user-1';
const playerId = 'player-1';

interface Scenario {
  /** The user's non-deleted player row, or null when there is none. */
  playerRow?: Record<string, unknown> | null;
  /** The game row, or null when the game does not exist. */
  gameRow?: Record<string, unknown> | null;
  /** The id of the player at current_player_index, or null when none. */
  activePlayerId?: string | null;
}

/** Answers the helper's three queries by SQL shape and records every statement. */
function scriptQueries(query: jest.Mock, scenario: Scenario = {}): void {
  const playerRow = scenario.playerRow === undefined
    ? { id: playerId, money: 50, debtOwed: 0, hand: [1, 2, 3], loads: [], turnNumber: 3, trainType: 'freight' }
    : scenario.playerRow;
  const gameRow = scenario.gameRow === undefined
    ? { current_player_index: 0, status: 'active' }
    : scenario.gameRow;
  const activePlayerId = scenario.activePlayerId === undefined ? playerId : scenario.activePlayerId;

  query.mockImplementation((sql: string) => {
    if (sql.includes('FROM players') && sql.includes('user_id = $2')) {
      return Promise.resolve({ rows: playerRow ? [playerRow] : [] });
    }
    if (sql.includes('FROM games')) {
      return Promise.resolve({ rows: gameRow ? [gameRow] : [] });
    }
    if (sql.includes('FROM players') && sql.includes('OFFSET $2')) {
      return Promise.resolve({ rows: activePlayerId ? [{ id: activePlayerId }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

function sqlOf(query: jest.Mock): string[] {
  return query.mock.calls.map((call) => String(call[0]));
}

async function expectGuardError(promise: Promise<unknown>, code: TurnGuardErrorCode, httpStatus: number): Promise<TurnGuardError> {
  const error = await promise.then(
    () => { throw new Error('expected the guard to throw'); },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(TurnGuardError);
  const guardError = error as TurnGuardError;
  expect(guardError.code).toBe(code);
  expect(guardError.httpStatus).toBe(httpStatus);
  return guardError;
}

describe('lockPlayerForUserTurn', () => {
  let query: jest.Mock;
  let client: PoolClient;

  beforeEach(() => {
    query = jest.fn();
    client = { query } as unknown as PoolClient;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns the locked player row, index and status for the current player', async () => {
    scriptQueries(query);

    const result = await lockPlayerForUserTurn(client, gameId, userId);

    expect(result.player.id).toBe(playerId);
    expect(result.player.money).toBe(50);
    expect(result.currentPlayerIndex).toBe(0);
    expect(result.gameStatus).toBe('active');
  });

  it('locks the player row and the game row FOR UPDATE and skips deleted players', async () => {
    scriptQueries(query);

    await lockPlayerForUserTurn(client, gameId, userId);

    const [playerSql, gameSql] = sqlOf(query);
    expect(playerSql).toContain('is_deleted = false');
    expect(playerSql).toContain('FOR UPDATE');
    expect(gameSql).toContain('FROM games');
    expect(gameSql).toContain('FOR UPDATE');
    expect(query.mock.calls[0][1]).toEqual([gameId, userId]);
  });

  it('finds the current player over all players so the index matches turn advancement', async () => {
    scriptQueries(query, { gameRow: { current_player_index: 2, status: 'active' } });

    const result = await lockPlayerForUserTurn(client, gameId, userId);

    const activeSql = sqlOf(query)[2];
    expect(activeSql).toContain('ORDER BY created_at ASC');
    expect(activeSql).not.toContain('is_deleted');
    expect(query.mock.calls[2][1]).toEqual([gameId, 2]);
    expect(result.currentPlayerIndex).toBe(2);
  });

  it('rejects a user who is not a member with 403', async () => {
    scriptQueries(query, { playerRow: null });

    const error = await expectGuardError(
      lockPlayerForUserTurn(client, gameId, userId),
      TurnGuardErrorCode.NotAMember,
      403,
    );
    expect(error.message).toBe('Player not found in game');
    // Stops before reading the game.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a soft-deleted player the same way as a non-member', async () => {
    // The player query filters is_deleted = false, so a deleted player's row is not returned.
    query.mockImplementation((sql: string) => {
      if (sql.includes('user_id = $2')) {
        const deletedRowIsVisible = !sql.includes('is_deleted = false');
        return Promise.resolve({ rows: deletedRowIsVisible ? [{ id: playerId }] : [] });
      }
      return Promise.resolve({ rows: [{ current_player_index: 0, status: 'active', id: playerId }] });
    });

    await expectGuardError(
      lockPlayerForUserTurn(client, gameId, userId),
      TurnGuardErrorCode.NotAMember,
      403,
    );
  });

  it('rejects a missing game with 404', async () => {
    scriptQueries(query, { gameRow: null });

    await expectGuardError(
      lockPlayerForUserTurn(client, gameId, userId),
      TurnGuardErrorCode.GameNotFound,
      404,
    );
  });

  it.each(['setup', 'initialBuild', 'completed', 'abandoned'])(
    'rejects status %s with 409 by default',
    async (status) => {
      scriptQueries(query, { gameRow: { current_player_index: 0, status } });

      const error = await expectGuardError(
        lockPlayerForUserTurn(client, gameId, userId),
        TurnGuardErrorCode.WrongStatus,
        409,
      );
      expect(error.message).toContain(status);
    },
  );

  it('allows a status the caller opts into', async () => {
    scriptQueries(query, { gameRow: { current_player_index: 0, status: 'initialBuild' } });

    const result = await lockPlayerForUserTurn(client, gameId, userId, {
      allowedStatuses: ['initialBuild', 'active'],
    });

    expect(result.gameStatus).toBe('initialBuild');
  });

  it('rejects a player who is not the current player with 403', async () => {
    scriptQueries(query, { activePlayerId: 'someone-else' });

    const error = await expectGuardError(
      lockPlayerForUserTurn(client, gameId, userId),
      TurnGuardErrorCode.NotYourTurn,
      403,
    );
    expect(error.message).toBe('Not your turn');
  });

  it('rejects with 409 when the index points at no player', async () => {
    scriptQueries(query, { activePlayerId: null });

    await expectGuardError(
      lockPlayerForUserTurn(client, gameId, userId),
      TurnGuardErrorCode.NoActivePlayer,
      409,
    );
  });

  it('checks status before turn', async () => {
    scriptQueries(query, {
      gameRow: { current_player_index: 0, status: 'completed' },
      activePlayerId: 'someone-else',
    });

    await expectGuardError(
      lockPlayerForUserTurn(client, gameId, userId),
      TurnGuardErrorCode.WrongStatus,
      409,
    );
  });
});

describe('TurnGuardError.toResponseBody', () => {
  it('names the code and keeps the message as details', () => {
    const body = new TurnGuardError(TurnGuardErrorCode.NotYourTurn, 'Not your turn').toResponseBody();

    expect(body).toEqual({ error: 'Forbidden', code: 'NotYourTurn', details: 'Not your turn' });
  });

  it('labels a status conflict', () => {
    const body = new TurnGuardError(TurnGuardErrorCode.WrongStatus, 'nope').toResponseBody();

    expect(body.error).toBe('Conflict');
    expect(body.code).toBe('WrongStatus');
  });
});

describe('assertUserTurn', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('commits and releases the connection when the user may act', async () => {
    scriptQueries(pooledClient.query);

    await expect(assertUserTurn(gameId, userId)).resolves.toBeUndefined();

    const statements = sqlOf(pooledClient.query);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[statements.length - 1]).toBe('COMMIT');
    expect(pooledClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back, releases and rethrows when the user may not act', async () => {
    scriptQueries(pooledClient.query, { activePlayerId: 'someone-else' });

    await expectGuardError(assertUserTurn(gameId, userId), TurnGuardErrorCode.NotYourTurn, 403);

    const statements = sqlOf(pooledClient.query);
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(pooledClient.release).toHaveBeenCalledTimes(1);
  });
});

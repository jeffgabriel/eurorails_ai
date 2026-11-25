import type { PoolClient } from "pg";
import { db } from "../db/index";
import { GameStatus } from "../../shared/types/GameTypes";

/** Why a turn-guarded action was refused. */
export enum TurnGuardErrorCode {
  /** The game row does not exist. */
  GameNotFound = 0,
  /** The user has no player in the game, or that player is soft-deleted. */
  NotAMember = 1,
  /** The game's status does not allow this action (e.g. setup, completed). */
  WrongStatus = 2,
  /** The user's player is not the current player. */
  NotYourTurn = 3,
  /** The game's current_player_index does not point at a player. */
  NoActivePlayer = 4,
}

const HTTP_STATUS_BY_CODE: Record<TurnGuardErrorCode, number> = {
  [TurnGuardErrorCode.GameNotFound]: 404,
  [TurnGuardErrorCode.NotAMember]: 403,
  [TurnGuardErrorCode.WrongStatus]: 409,
  [TurnGuardErrorCode.NotYourTurn]: 403,
  [TurnGuardErrorCode.NoActivePlayer]: 409,
};

const HTTP_ERROR_LABEL: Record<number, string> = {
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
};

/**
 * Thrown by `lockPlayerForUserTurn` when the caller may not act right now.
 * The messages for NotAMember and NotYourTurn match the strings the old
 * per-method checks threw, so bot error handling and logs read the same.
 */
export class TurnGuardError extends Error {
  public readonly httpStatus: number;

  constructor(
    public readonly code: TurnGuardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TurnGuardError";
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }

  /** JSON body for an HTTP response, in the shape the player routes already use. */
  toResponseBody(): { error: string; code: string; details: string } {
    return {
      error: HTTP_ERROR_LABEL[this.httpStatus],
      code: TurnGuardErrorCode[this.code],
      details: this.message,
    };
  }
}

/** The locked player row, with the columns the turn-guarded actions read. */
export interface TurnGuardPlayerRow {
  id: string;
  money: number;
  debtOwed: number | null;
  hand: unknown;
  loads: unknown;
  turnNumber: number | null;
  trainType: string;
  position_row: number | null;
  position_col: number | null;
  position_x: number | null;
  position_y: number | null;
}

export interface TurnGuardOptions {
  /** Game statuses in which the action is legal. Defaults to `['active']`. */
  allowedStatuses?: readonly GameStatus[];
}

export interface TurnGuardResult {
  player: TurnGuardPlayerRow;
  currentPlayerIndex: number;
  gameStatus: GameStatus;
}

const DEFAULT_ALLOWED_STATUSES: readonly GameStatus[] = ["active"];

/**
 * Lock the user's player row and the game row, and confirm the user may act:
 * they have a non-deleted player in the game, the game's status allows the
 * action, and it is that player's turn.
 *
 * Must run inside the caller's transaction. Both rows stay locked (FOR UPDATE)
 * until the caller commits or rolls back, so the funds, hand and turn checks
 * that follow cannot race a second request.
 *
 * The current player is the row at `games.current_player_index` in
 * `created_at` order over ALL of the game's players, soft-deleted included.
 * That is the indexing `getPlayers`, `advanceTurn` and `InitialBuildService`
 * use, so it is the one the index was written with.
 *
 * @throws TurnGuardError when any check fails.
 */
export async function lockPlayerForUserTurn(
  client: PoolClient,
  gameId: string,
  userId: string,
  opts: TurnGuardOptions = {},
): Promise<TurnGuardResult> {
  const allowedStatuses = opts.allowedStatuses ?? DEFAULT_ALLOWED_STATUSES;

  const playerResult = await client.query(
    `SELECT id, money, debt_owed as "debtOwed", hand, loads,
            current_turn_number as "turnNumber", train_type as "trainType",
            position_row, position_col, position_x, position_y
     FROM players
     WHERE game_id = $1 AND user_id = $2 AND is_deleted = false
     LIMIT 1
     FOR UPDATE`,
    [gameId, userId],
  );
  if (playerResult.rows.length === 0) {
    throw new TurnGuardError(TurnGuardErrorCode.NotAMember, "Player not found in game");
  }
  const player = playerResult.rows[0] as TurnGuardPlayerRow;

  const gameResult = await client.query(
    `SELECT current_player_index, status
     FROM games
     WHERE id = $1
     LIMIT 1
     FOR UPDATE`,
    [gameId],
  );
  if (gameResult.rows.length === 0) {
    throw new TurnGuardError(TurnGuardErrorCode.GameNotFound, "Game not found");
  }
  const gameStatus = gameResult.rows[0].status as GameStatus;
  if (!allowedStatuses.includes(gameStatus)) {
    throw new TurnGuardError(
      TurnGuardErrorCode.WrongStatus,
      `Action not allowed while the game is ${gameStatus}`,
    );
  }

  const currentPlayerIndex = Number(gameResult.rows[0].current_player_index ?? 0);
  const activeResult = await client.query(
    "SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2",
    [gameId, currentPlayerIndex],
  );
  const activePlayerId = activeResult.rows[0]?.id as string | undefined;
  if (!activePlayerId) {
    throw new TurnGuardError(TurnGuardErrorCode.NoActivePlayer, "Game has no active player");
  }
  if (activePlayerId !== player.id) {
    throw new TurnGuardError(TurnGuardErrorCode.NotYourTurn, "Not your turn");
  }

  return { player, currentPlayerIndex, gameStatus };
}

/**
 * Check-only form of `lockPlayerForUserTurn` for callers that do not run their
 * own transaction. The locks are released before this returns, so it does not
 * serialize the action that follows.
 *
 * @throws TurnGuardError when any check fails.
 */
export async function assertUserTurn(
  gameId: string,
  userId: string,
  opts: TurnGuardOptions = {},
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockPlayerForUserTurn(client, gameId, userId, opts);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

import { db } from "../db/index";
import { PlayerColor } from "../../shared/types/GameTypes";
import { cleanupGameState } from "./gameCleanupService";

/** Why an in-game Settings action was refused. */
export enum GameSettingsErrorCode {
  /** The game row does not exist. */
  GameNotFound = 0,
  /** The caller did not create the game. */
  NotCreator = 1,
  /** The target player is not in the game. */
  PlayerNotFound = 2,
  /** The creator tried to delete their own player. */
  CannotDeleteSelf = 3,
  /** Deleting would leave fewer than two players. */
  TooFewPlayers = 4,
  /** The target is the current player; their turn must end first. */
  PlayerHasTurn = 5,
  /** A victory declaration is pending, which pins player indexes. */
  VictoryPending = 6,
  /** The game is completed or abandoned. */
  GameOver = 7,
  /** The caller has no (non-deleted) player in the game. */
  NotAMember = 8,
  /** The name is empty or too long. */
  InvalidName = 9,
  /** The color is not one of the player colors. */
  InvalidColor = 10,
  /** Another player in the game already uses the color. */
  ColorTaken = 11,
}

const HTTP_STATUS_BY_CODE: Record<GameSettingsErrorCode, number> = {
  [GameSettingsErrorCode.GameNotFound]: 404,
  [GameSettingsErrorCode.NotCreator]: 403,
  [GameSettingsErrorCode.PlayerNotFound]: 404,
  [GameSettingsErrorCode.CannotDeleteSelf]: 400,
  [GameSettingsErrorCode.TooFewPlayers]: 409,
  [GameSettingsErrorCode.PlayerHasTurn]: 409,
  [GameSettingsErrorCode.VictoryPending]: 409,
  [GameSettingsErrorCode.GameOver]: 409,
  [GameSettingsErrorCode.NotAMember]: 403,
  [GameSettingsErrorCode.InvalidName]: 400,
  [GameSettingsErrorCode.InvalidColor]: 400,
  [GameSettingsErrorCode.ColorTaken]: 409,
};

const HTTP_ERROR_LABEL: Record<number, string> = {
  400: "Validation error",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
};

/** Thrown by `GameSettingsService` when an action is not allowed. */
export class GameSettingsError extends Error {
  public readonly httpStatus: number;

  constructor(
    public readonly code: GameSettingsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameSettingsError";
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }

  /** JSON body for an HTTP response, in the shape the player routes use. */
  toResponseBody(): { error: string; code: string; details: string } {
    return {
      error: HTTP_ERROR_LABEL[this.httpStatus],
      code: GameSettingsErrorCode[this.code],
      details: this.message,
    };
  }
}

/** Longest player name the Settings edit accepts. */
export const MAX_PLAYER_NAME_LENGTH = 20;

const ALLOWED_COLORS: ReadonlySet<string> = new Set(
  Object.values(PlayerColor).map((color) => color.toLowerCase()),
);

export interface OwnPlayerChanges {
  name?: string;
  color?: string;
}

export interface OwnPlayerProfile {
  id: string;
  name: string;
  color: string;
}

export interface RemovePlayerResult {
  /** `games.current_player_index` after the removal. */
  currentPlayerIndex: number;
}

/**
 * The actions behind the in-game Settings menu: the creator deletes a player or
 * ends the game, and any player edits their own name and color.
 *
 * Every method takes the authenticated user's id and checks it against the
 * database inside the same transaction as the change.
 *
 * Lock order: player rows first, then the game row. That is the order
 * `lockPlayerForUserTurn` uses, so these actions cannot deadlock against a
 * turn-guarded action running at the same moment.
 */
export class GameSettingsService {
  /**
   * Confirm the locked game row belongs to the caller.
   *
   * @throws GameSettingsError when the game is missing or the caller did not create it.
   */
  private static assertCreator(
    game: { created_by: string | null } | undefined,
    userId: string,
    notCreatorMessage: string,
  ): void {
    if (!game) {
      throw new GameSettingsError(GameSettingsErrorCode.GameNotFound, "Game not found");
    }
    if (!game.created_by || game.created_by !== userId) {
      throw new GameSettingsError(GameSettingsErrorCode.NotCreator, notCreatorMessage);
    }
  }

  private static isGameOver(status: string): boolean {
    return status === "completed" || status === "abandoned";
  }

  /**
   * Permanently delete a player (with their track and movement history) from a
   * game. Only the game's creator may do this, and not to their own player.
   *
   * `games.current_player_index` indexes the game's players in `created_at`
   * order, so removing a row shifts everyone after it. The index is corrected
   * here so it keeps pointing at the same player. Removing the player it
   * points at is refused, as is removal while a victory declaration is
   * pending (the victory columns hold player indexes too).
   *
   * @throws GameSettingsError when the removal is not allowed.
   */
  static async removePlayer(
    gameId: string,
    creatorUserId: string,
    playerId: string,
  ): Promise<RemovePlayerResult> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Players before the game row (see the lock order note on the class).
      // A player who joins between the two locks sorts after everyone here, so
      // the indexes computed below still hold.
      const playersResult = await client.query(
        `SELECT id, user_id, is_deleted FROM players
         WHERE game_id = $1 ORDER BY created_at ASC FOR UPDATE`,
        [gameId],
      );
      const players = playersResult.rows as Array<{
        id: string;
        user_id: string | null;
        is_deleted: boolean | null;
      }>;

      const gameResult = await client.query(
        `SELECT created_by, status, current_player_index, initial_build_order, victory_triggered
         FROM games WHERE id = $1 FOR UPDATE`,
        [gameId],
      );
      const game = gameResult.rows[0];
      GameSettingsService.assertCreator(game, creatorUserId, "Only the game creator can delete a player");
      if (GameSettingsService.isGameOver(game.status)) {
        throw new GameSettingsError(
          GameSettingsErrorCode.GameOver,
          `Cannot delete a player from a game that is ${game.status}`,
        );
      }

      const targetIndex = players.findIndex((p) => p.id === playerId);
      if (targetIndex === -1) {
        throw new GameSettingsError(
          GameSettingsErrorCode.PlayerNotFound,
          "Player not found in game",
        );
      }
      const target = players[targetIndex];
      if (target.user_id === creatorUserId) {
        throw new GameSettingsError(
          GameSettingsErrorCode.CannotDeleteSelf,
          "You cannot delete your own player",
        );
      }

      const remaining = players.filter((p) => p.id !== playerId && p.is_deleted !== true);
      if (remaining.length < 2) {
        throw new GameSettingsError(
          GameSettingsErrorCode.TooFewPlayers,
          "A game needs at least two players",
        );
      }

      const currentPlayerIndex = Number(game.current_player_index ?? 0);
      const turnsInProgress = game.status === "initialBuild" || game.status === "active";
      if (turnsInProgress) {
        if (game.victory_triggered === true) {
          throw new GameSettingsError(
            GameSettingsErrorCode.VictoryPending,
            "Cannot delete a player while a victory declaration is pending",
          );
        }
        if (targetIndex === currentPlayerIndex) {
          throw new GameSettingsError(
            GameSettingsErrorCode.PlayerHasTurn,
            "Cannot delete a player during their turn",
          );
        }
      }

      await client.query("DELETE FROM movement_history WHERE player_id = $1", [playerId]);
      await client.query("DELETE FROM player_tracks WHERE player_id = $1", [playerId]);
      await client.query("DELETE FROM players WHERE game_id = $1 AND id = $2", [gameId, playerId]);

      let nextIndex = currentPlayerIndex;
      if (targetIndex < currentPlayerIndex) {
        nextIndex = currentPlayerIndex - 1;
      } else if (currentPlayerIndex >= players.length - 1) {
        // Only reachable outside initialBuild/active, where the index is not in use.
        nextIndex = 0;
      }

      const buildOrder: string[] | null = Array.isArray(game.initial_build_order)
        ? (game.initial_build_order as string[]).filter((id) => id !== playerId)
        : null;

      await client.query(
        `UPDATE games
         SET current_player_index = $1,
             initial_build_order = COALESCE($2::jsonb, initial_build_order),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [nextIndex, buildOrder ? JSON.stringify(buildOrder) : null, gameId],
      );

      await client.query("COMMIT");
      return { currentPlayerIndex: nextIndex };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * End a game (status `completed`). Only the game's creator may do this.
   * Ending an already finished game is a no-op.
   *
   * @throws GameSettingsError when the caller is not the creator.
   */
  static async endGame(gameId: string, creatorUserId: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const gameResult = await client.query(
        "SELECT created_by, status FROM games WHERE id = $1 FOR UPDATE",
        [gameId],
      );
      const game = gameResult.rows[0];
      GameSettingsService.assertCreator(game, creatorUserId, "Only the game creator can end the game");

      const alreadyOver = GameSettingsService.isGameOver(game.status);
      if (!alreadyOver) {
        await client.query(
          "UPDATE games SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [gameId],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Release the game's in-memory state once it is over (idempotent).
    await cleanupGameState(gameId);
  }

  /**
   * Change the name and/or color of the caller's own player. Nothing else
   * about the player can be changed here, and no other player can be targeted:
   * the row is found by the authenticated user's id.
   *
   * @throws GameSettingsError on invalid input, a color conflict, or when the
   *   caller has no player in the game.
   */
  static async updateOwnPlayer(
    gameId: string,
    userId: string,
    changes: OwnPlayerChanges,
  ): Promise<OwnPlayerProfile> {
    let name: string | null = null;
    if (changes.name !== undefined) {
      name = typeof changes.name === "string" ? changes.name.trim() : "";
      if (name.length === 0 || name.length > MAX_PLAYER_NAME_LENGTH) {
        throw new GameSettingsError(
          GameSettingsErrorCode.InvalidName,
          `Name must be 1 to ${MAX_PLAYER_NAME_LENGTH} characters`,
        );
      }
    }

    let color: string | null = null;
    if (changes.color !== undefined) {
      color = typeof changes.color === "string" ? changes.color.toLowerCase() : "";
      if (!ALLOWED_COLORS.has(color)) {
        throw new GameSettingsError(
          GameSettingsErrorCode.InvalidColor,
          "Color must be one of the player colors",
        );
      }
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const playerResult = await client.query(
        `SELECT id FROM players
         WHERE game_id = $1 AND user_id = $2 AND is_deleted = false
         LIMIT 1 FOR UPDATE`,
        [gameId, userId],
      );
      if (playerResult.rows.length === 0) {
        throw new GameSettingsError(
          GameSettingsErrorCode.NotAMember,
          "Player not found in game",
        );
      }
      const playerId = playerResult.rows[0].id as string;

      // Lock the game row (after the player row: see the lock order note on the
      // class) so two players cannot claim the same color at once.
      await client.query("SELECT id FROM games WHERE id = $1 FOR UPDATE", [gameId]);

      if (color !== null) {
        const conflict = await client.query(
          "SELECT id FROM players WHERE game_id = $1 AND LOWER(color) = $2 AND id != $3",
          [gameId, color, playerId],
        );
        if (conflict.rows.length > 0) {
          throw new GameSettingsError(
            GameSettingsErrorCode.ColorTaken,
            "Color already taken by another player",
          );
        }
      }

      const updated = await client.query(
        `UPDATE players
         SET name = COALESCE($1, name), color = COALESCE($2, color)
         WHERE id = $3
         RETURNING id, name, color`,
        [name, color, playerId],
      );

      await client.query("COMMIT");
      return updated.rows[0] as OwnPlayerProfile;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

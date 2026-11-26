import type { PoolClient } from "pg";
import { isPositionAtCity } from "../../shared/services/cityPositionResolver";
import { DroppedLoad, LoadTrayChange, LoadType } from "../../shared/types/LoadTypes";
import { LoadService } from "./loadService";
import { loadGridPoints } from "./MapTopology";

/** Why a load pickup, drop or undo was refused. */
export enum LoadActionErrorCode {
  /** The train is not on a milepost of the named city. */
  TrainNotAtCity = 0,
  /** The train already carries as many loads as its type allows. */
  NoCapacity = 1,
  /** The city neither produces the load nor holds a dropped chip of it. */
  LoadNotAvailable = 2,
  /** The city produces the load, but every chip of it is in use. */
  NoChipsLeft = 3,
  /** The train does not carry the load. */
  LoadNotCarried = 4,
}

/**
 * Thrown when the board state does not allow a load action. Every code maps to
 * HTTP 409: the request was well formed, the game state refuses it.
 * The NoCapacity and LoadNotCarried messages match the strings the bot path
 * threw before this class existed.
 */
export class LoadActionError extends Error {
  public readonly httpStatus: number = 409;

  constructor(
    public readonly code: LoadActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LoadActionError";
  }

  /** JSON body for an HTTP response, in the shape the player routes already use. */
  toResponseBody(): { error: string; code: string; details: string } {
    return {
      error: "Conflict",
      code: LoadActionErrorCode[this.code],
      details: this.message,
    };
  }
}

/** Where a picked-up chip came from. */
export type LoadPickupSource = "tray" | "city";

/** Where a dropped chip went. */
export type LoadDropPlacement = "tray" | "city";

/** `turn_actions` entry for a pickup. `source` is absent on entries written by bots. */
export interface TurnActionPickup {
  kind: "pickup";
  city: string;
  loadType: LoadType;
  source?: LoadPickupSource;
}

/** `turn_actions` entry for a drop. */
export interface TurnActionDrop {
  kind: "drop";
  city: string;
  loadType: LoadType;
  placement: LoadDropPlacement;
  /** Chips that were lying in the city and went back to the tray. */
  displaced: LoadType[];
}

export interface TrainGridPosition {
  row: number | null;
  col: number | null;
}

export interface LoadActionArgs {
  gameId: string;
  playerId: string;
  loadType: LoadType;
  cityName: string;
  /** The player's loads, read from a row the caller holds locked FOR UPDATE. */
  currentLoads: LoadType[];
  /**
   * Board checks for requests that come from a client: the train must be at
   * the city, and a pickup must have a real chip to take. Bots plan against
   * the same rules before they call in, so their path leaves this out.
   */
  boardRules?: { position: TrainGridPosition };
}

function assertTrainAtCity(position: TrainGridPosition, cityName: string): void {
  const atCity =
    position.row !== null &&
    position.col !== null &&
    isPositionAtCity(position.row, position.col, cityName, loadGridPoints());
  if (!atCity) {
    throw new LoadActionError(
      LoadActionErrorCode.TrainNotAtCity,
      `Train is not at ${cityName}`,
    );
  }
}

/** Chips of a load type that are on trains or lying in cities in this game. */
async function countChipsInUse(
  client: PoolClient,
  gameId: string,
  loadType: LoadType,
): Promise<number> {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)
          FROM players p, unnest(p.loads) AS carried(load_type)
         WHERE p.game_id = $1 AND p.is_deleted = false AND carried.load_type = $2)
       +
       (SELECT COUNT(*)
          FROM load_chips
         WHERE game_id = $1 AND type = $2 AND is_dropped = true) AS in_use`,
    [gameId, loadType],
  );
  return Number(result.rows[0]?.in_use ?? 0);
}

/** Every dropped load chip in the game. */
export async function getDroppedLoadsInTransaction(
  client: PoolClient,
  gameId: string,
): Promise<DroppedLoad[]> {
  const result = await client.query(
    "SELECT city_name, type FROM load_chips WHERE is_dropped = true AND game_id = $1",
    [gameId],
  );
  return result.rows as DroppedLoad[];
}

/** Append one entry to the player's action log for the turn (read back by undo). */
export async function appendTurnAction(
  client: PoolClient,
  gameId: string,
  playerId: string,
  turnNumber: number,
  action: TurnActionPickup | TurnActionDrop,
): Promise<void> {
  await client.query(
    `INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (player_id, game_id, turn_number)
     DO UPDATE SET actions = turn_actions.actions || $4::jsonb, updated_at = CURRENT_TIMESTAMP`,
    [playerId, gameId, turnNumber, JSON.stringify([action])],
  );
}

/**
 * Put a load on the player's train, inside the caller's transaction.
 *
 * A chip dropped in the city is taken first; otherwise the chip comes from the
 * tray. The train's capacity is always checked.
 *
 * @throws LoadActionError when the board state does not allow the pickup.
 */
export async function pickupLoadInTransaction(
  client: PoolClient,
  args: LoadActionArgs & { capacity: number },
): Promise<{ updatedLoads: LoadType[]; source: LoadPickupSource }> {
  const { gameId, playerId, loadType, cityName, currentLoads, capacity, boardRules } = args;

  if (boardRules) {
    assertTrainAtCity(boardRules.position, cityName);
  }
  if (currentLoads.length >= capacity) {
    throw new LoadActionError(
      LoadActionErrorCode.NoCapacity,
      `Train at full capacity (${currentLoads.length}/${capacity})`,
    );
  }

  let source: LoadPickupSource = "tray";
  if (cityName) {
    const taken = await client.query(
      `UPDATE load_chips SET is_dropped = false
       WHERE city_name = $1 AND type = $2 AND game_id = $3 AND is_dropped = true
       RETURNING id`,
      [cityName, loadType, gameId],
    );
    if (taken.rows.length > 0) {
      source = "city";
    }
  }

  if (boardRules && source === "tray") {
    const loadService = LoadService.getInstance();
    if (!loadService.isLoadAvailableAtCity(loadType, cityName)) {
      throw new LoadActionError(
        LoadActionErrorCode.LoadNotAvailable,
        `${loadType} is not available at ${cityName}`,
      );
    }
    const inUse = await countChipsInUse(client, gameId, loadType);
    if (inUse >= loadService.getTotalLoadCount(loadType)) {
      throw new LoadActionError(
        LoadActionErrorCode.NoChipsLeft,
        `No ${loadType} chips are left in the tray`,
      );
    }
  }

  const updateResult = await client.query(
    `UPDATE players SET loads = array_append(loads, $1)
     WHERE id = $2 AND game_id = $3
     RETURNING loads`,
    [loadType, playerId, gameId],
  );
  return { updatedLoads: updateResult.rows[0].loads as LoadType[], source };
}

/**
 * Take a load off the player's train at a city, inside the caller's transaction.
 *
 * City-drop rule: a load the city produces goes back to the tray. Any other
 * load stays in the city, and a chip already lying there goes back to the tray.
 *
 * @throws LoadActionError when the board state does not allow the drop.
 */
export async function dropLoadInTransaction(
  client: PoolClient,
  args: LoadActionArgs,
): Promise<{ updatedLoads: LoadType[]; placement: LoadDropPlacement; displaced: LoadType[] }> {
  const { gameId, playerId, loadType, cityName, currentLoads, boardRules } = args;

  if (boardRules) {
    assertTrainAtCity(boardRules.position, cityName);
  }
  if (!currentLoads.includes(loadType)) {
    throw new LoadActionError(
      LoadActionErrorCode.LoadNotCarried,
      `Player is not carrying load: ${loadType}`,
    );
  }

  // Remove only the first occurrence of this load type. array_remove would
  // strip every copy (e.g. both Oils on a Heavy Freight), so splice here;
  // the caller holds the row locked, so writing the array back is safe.
  const updatedLoads = [...currentLoads];
  updatedLoads.splice(updatedLoads.indexOf(loadType), 1);
  await client.query(
    `UPDATE players SET loads = $1
     WHERE id = $2 AND game_id = $3`,
    [updatedLoads, playerId, gameId],
  );

  if (LoadService.getInstance().isLoadAvailableAtCity(loadType, cityName)) {
    return { updatedLoads, placement: "tray", displaced: [] };
  }

  const displacedResult = await client.query(
    `UPDATE load_chips SET is_dropped = false
     WHERE city_name = $1 AND game_id = $2 AND is_dropped = true
     RETURNING type`,
    [cityName, gameId],
  );
  await client.query(
    "INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)",
    [gameId, loadType, cityName],
  );
  const displaced = (displacedResult.rows as Array<{ type: LoadType }>).map((row) => row.type);
  return { updatedLoads, placement: "city", displaced };
}

/** Tray changes a pickup caused. */
export function trayChangesForPickup(loadType: LoadType, source: LoadPickupSource): LoadTrayChange[] {
  return source === "tray" ? [{ loadType, delta: -1 }] : [];
}

/** Tray changes a drop caused. */
export function trayChangesForDrop(
  loadType: LoadType,
  placement: LoadDropPlacement,
  displaced: LoadType[],
): LoadTrayChange[] {
  if (placement === "tray") {
    return [{ loadType, delta: 1 }];
  }
  return displaced.map((displacedType) => ({ loadType: displacedType, delta: 1 }));
}

/**
 * Reverse a pickup or drop recorded in `turn_actions`, inside the caller's
 * transaction: the train's loads and the city's dropped chips go back to what
 * they were before the action. The caller pops the entry from the log.
 *
 * No position check: the log is undone newest first, so any move made after
 * the action has already been undone.
 *
 * @throws LoadActionError when the train's loads no longer allow the undo.
 */
export async function undoLoadActionInTransaction(
  client: PoolClient,
  args: {
    gameId: string;
    playerId: string;
    action: TurnActionPickup | TurnActionDrop;
    currentLoads: LoadType[];
    capacity: number;
  },
): Promise<{ updatedLoads: LoadType[]; trayChanges: LoadTrayChange[] }> {
  const { gameId, playerId, action, currentLoads, capacity } = args;
  const { loadType, city } = action;
  const updatedLoads = [...currentLoads];
  let trayChanges: LoadTrayChange[];

  if (action.kind === "pickup") {
    const index = updatedLoads.lastIndexOf(loadType);
    if (index === -1) {
      throw new LoadActionError(
        LoadActionErrorCode.LoadNotCarried,
        `Player is not carrying load: ${loadType}`,
      );
    }
    updatedLoads.splice(index, 1);
    if (action.source === "city") {
      await client.query(
        "INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)",
        [gameId, loadType, city],
      );
      trayChanges = [];
    } else {
      trayChanges = [{ loadType, delta: 1 }];
    }
  } else {
    // A crossgrade after the drop can leave the train too small to take the load back.
    if (updatedLoads.length >= capacity) {
      throw new LoadActionError(
        LoadActionErrorCode.NoCapacity,
        `Train at full capacity (${updatedLoads.length}/${capacity})`,
      );
    }
    updatedLoads.push(loadType);
    if (action.placement === "city") {
      const displaced = Array.isArray(action.displaced) ? action.displaced : [];
      await client.query(
        `UPDATE load_chips SET is_dropped = false
         WHERE city_name = $1 AND type = $2 AND game_id = $3 AND is_dropped = true`,
        [city, loadType, gameId],
      );
      for (const displacedType of displaced) {
        await client.query(
          "INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)",
          [gameId, displacedType, city],
        );
      }
      trayChanges = displaced.map((displacedType) => ({ loadType: displacedType, delta: -1 }));
    } else {
      trayChanges = [{ loadType, delta: -1 }];
    }
  }

  await client.query(
    `UPDATE players SET loads = $1
     WHERE id = $2 AND game_id = $3`,
    [updatedLoads, playerId, gameId],
  );
  return { updatedLoads, trayChanges };
}

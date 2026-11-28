/**
 * Server-side rule for putting a train on the board (issue #311).
 *
 * A player's train starts off the board. On their turn they choose a city and
 * the train is placed there; after that it only moves through the validated
 * move path. This module decides where a train may be placed. It is pure: the
 * caller checks whose turn it is and whether the train is already placed.
 */

import { gridToPixel, makeKey } from "./MapTopology";
import { isCityMilepost } from "./trainMovement";

/** Why a train placement was refused. */
export enum TrainPlacementErrorCode {
  /** The request does not name a milepost with an integer row and col. */
  InvalidTarget = 0,
  /** The milepost is not a city: a train starts at a city. */
  NotACity = 1,
  /** The train is already on the board; it moves from here, it is not placed again. */
  AlreadyPlaced = 2,
}

const MALFORMED_REQUEST_CODES: ReadonlySet<TrainPlacementErrorCode> = new Set([
  TrainPlacementErrorCode.InvalidTarget,
  TrainPlacementErrorCode.NotACity,
]);

/**
 * Thrown when a train may not be placed. A target that could never be legal
 * maps to HTTP 400; a train that is already placed maps to 409.
 */
export class TrainPlacementError extends Error {
  public readonly httpStatus: number;

  constructor(
    public readonly code: TrainPlacementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TrainPlacementError";
    this.httpStatus = MALFORMED_REQUEST_CODES.has(code) ? 400 : 409;
  }

  /** JSON body for an HTTP response, in the shape the player routes already use. */
  toResponseBody(): { error: string; code: string; details: string } {
    return {
      error: this.httpStatus === 400 ? "Validation error" : "Conflict",
      code: TrainPlacementErrorCode[this.code],
      details: this.message,
    };
  }
}

/** Where a train stands: its milepost and that milepost's pixel position. */
export interface TrainPlacement {
  row: number;
  col: number;
  x: number;
  y: number;
}

/**
 * Check a requested starting milepost and work out where the train stands.
 *
 * Only `row` and `col` are read from the request. The milepost must be a city
 * on the map: any milepost of a major city (center or outer), or a medium or
 * small city. The pixel position comes from the map, never from the caller.
 *
 * @throws TrainPlacementError InvalidTarget or NotACity.
 */
export function resolveTrainPlacement(target: unknown): TrainPlacement {
  const { row, col } = (typeof target === "object" && target !== null ? target : {}) as {
    row?: unknown;
    col?: unknown;
  };
  if (typeof row !== "number" || typeof col !== "number" || !Number.isInteger(row) || !Number.isInteger(col)) {
    throw new TrainPlacementError(
      TrainPlacementErrorCode.InvalidTarget,
      "A starting milepost with an integer row and col is required",
    );
  }
  if (!isCityMilepost(row, col)) {
    throw new TrainPlacementError(
      TrainPlacementErrorCode.NotACity,
      `(${makeKey(row, col)}) is not a city: a train starts at a city`,
    );
  }
  const pixel = gridToPixel(row, col);
  return { row, col, x: pixel.x, y: pixel.y };
}

import {
  buildUnionTrackGraph,
  edgeKey,
  nodeKey,
  parseNodeKey,
  PathEdge,
} from "../../shared/services/trackUsageFees";
import { getFerryEdges, getMajorCityLookup, isIntraCityEdge } from "../../shared/services/majorCityGroups";
import { isPositionAtCity } from "../../shared/services/cityPositionResolver";
import { getTrainSpeed } from "../../shared/services/trainProperties";
import { MovementRestriction } from "../../shared/types/EventCard";
import { TerrainType, TrainType } from "../../shared/types/GameTypes";
import { PlayerTrackState } from "../../shared/types/TrackTypes";
import { loadGridPoints } from "./MapTopology";

/**
 * Server-side train movement rules (issue #312): the per-turn milepost budget
 * and the path a move is charged for.
 *
 * The budget is not stored anywhere on its own. The server's record is the
 * `movement_history` row for (player, game, turn_number): every accepted move
 * appends one segment whose `cost` is the milepost count the SERVER computed.
 * Remaining movement is the turn's allowance minus the sum of those costs. The
 * row is keyed by `players.current_turn_number`, so the budget resets when the
 * turn number is incremented (`PlayerService.endTurnForUser` for humans,
 * `BotTurnTrigger.onTurnChange` for bots).
 *
 * Event modifiers (issue #313): half rate, Snow-blocked mileposts and the Rail
 * Strike are applied while the route is walked, one milepost at a time, by the
 * functions in the "Event movement rules" section below. Half rate cannot be a
 * plain per-turn allowance, because it can start partway through a turn, so
 * each segment the server writes also carries the budget state after it
 * (`remainingAfter`, `halfRate`); the next move of the turn continues from the
 * last segment's state.
 *
 * Ferry and reversal rules (issue #314), in the "Ferry and reversal rules"
 * section below:
 * - A ferry is crossed only as the first move of a turn, by a train that
 *   began the turn on the ferry port. The crossing uses no mileposts and the
 *   rest of that turn is at half rate. A train therefore has to end a turn on
 *   the port before it can cross; a port it does not cross from is an ordinary
 *   milepost.
 * - A train may not go straight back along the edge it last arrived by, unless
 *   it stands on a city milepost or a ferry port. Each segment the server
 *   writes carries `arrivedFrom`, the milepost before its destination.
 */

/** Why a move or delivery was refused by the movement rules. */
export enum MovementRuleErrorCode {
  /** The destination is not a pair of integer grid coordinates. */
  InvalidDestination = 0,
  /** The first placement of a train is not on a city milepost. */
  StartNotACity = 1,
  /** No route to the destination fits in the movement left this turn. */
  MovementExceeded = 2,
  /** The train is not in the city the delivery names. */
  NotAtDeliveryCity = 3,
  /** The move turns the train straight back where it is not on a city or ferry port. */
  IllegalReversal = 4,
  /** The move needs a ferry the train may not cross now. */
  FerryNotAvailable = 5,
  /** The train was upgraded or crossgraded this turn; movement comes before a purchase. */
  MovedAfterPurchase = 6,
}

/**
 * Thrown when a move or delivery breaks a movement rule. Every message starts
 * with "Invalid", which the player routes already map to HTTP 400.
 */
export class MovementRuleError extends Error {
  constructor(
    public readonly code: MovementRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MovementRuleError";
  }
}

/**
 * Adjusts the allowance a turn STARTS with. Use it for a reason that is known
 * before the train moves (see `halfRateAllowance`). A reason that can begin
 * partway through a turn (a weather zone) is not a modifier: it is applied
 * while the route is walked (`beginMoveAt`, `enterMilepost`).
 */
export type MovementAllowanceModifier = (allowance: number) => number;

/** Half of a movement amount, fractions rounded up (9 -> 5, 12 -> 6, 5 -> 3). */
export function halveMovement(mileposts: number): number {
  return Math.ceil(Math.max(0, mileposts) / 2);
}

/**
 * The modifier for a turn that starts at half rate: Freight and Heavy Freight
 * 5, Fast Freight and Superfreight 6.
 */
export const halfRateAllowance: MovementAllowanceModifier = halveMovement;

/**
 * Mileposts the train may move in one turn: the train type's speed, passed
 * through any modifiers in order. Never negative.
 */
export function getTurnMovementAllowance(
  trainType: TrainType,
  modifiers: readonly MovementAllowanceModifier[] = [],
): number {
  let allowance = getTrainSpeed(trainType);
  for (const modify of modifiers) {
    allowance = modify(allowance);
  }
  return Math.max(0, Math.floor(allowance));
}

/**
 * Mileposts already used this turn: the sum of the segment costs in the turn's
 * `movement_history.movement_path`. Costs that are not finite positive numbers
 * count as zero, so a row written before the server computed the cost (when
 * the client could send a negative one) cannot raise the budget.
 */
export function sumMovementUsed(movementPath: unknown): number {
  if (!Array.isArray(movementPath)) return 0;
  let used = 0;
  for (const segment of movementPath) {
    const cost: unknown = (segment as { cost?: unknown } | null)?.cost;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
      used += cost;
    }
  }
  return used;
}

/**
 * Mileposts left this turn at the plain allowance: no event rules, and no
 * stored half-rate state. `readTurnMovementState` is the full answer.
 */
export function computeRemainingMovement(
  trainType: TrainType,
  movementPath: unknown,
  modifiers: readonly MovementAllowanceModifier[] = [],
): number {
  return Math.max(0, getTurnMovementAllowance(trainType, modifiers) - sumMovementUsed(movementPath));
}

// ── Event movement rules (issue #313) ────────────────────────────────────────

/** What is left of a turn's movement, and whether half rate has been applied to it. */
export type MovementBudgetState = {
  /** Mileposts the train may still move this turn. */
  remaining: number;
  /**
   * True once this turn's movement has been halved. Half rate is applied at
   * most once per turn, whatever the number of reasons for it, and stays in
   * force for the rest of the turn.
   */
  halfRateApplied: boolean;
};

/** The movement rules the active event effects impose, as lookup sets. */
export type MovementEventRules = {
  /** Mileposts ("row,col") where trains move at half rate (Snow). */
  halfRateZone: ReadonlySet<string>;
  /** Mileposts ("row,col") no train may move into (Snow: mountain or Alpine in the zone). */
  blockedMileposts: ReadonlySet<string>;
  /** Players whose track no train may move on (Rail Strike #123). */
  struckPlayerIds: ReadonlySet<string>;
};

export const NO_MOVEMENT_EVENT_RULES: MovementEventRules = {
  halfRateZone: new Set<string>(),
  blockedMileposts: new Set<string>(),
  struckPlayerIds: new Set<string>(),
};

/**
 * Collect the stored movement restrictions of the active effects
 * (`ActiveEffectRecord.restrictions.movement`) into lookup sets. Entries that
 * are not well-formed restrictions are ignored.
 */
export function movementEventRulesFrom(restrictions: unknown): MovementEventRules {
  if (!Array.isArray(restrictions) || restrictions.length === 0) {
    return NO_MOVEMENT_EVENT_RULES;
  }
  const halfRateZone = new Set<string>();
  const blockedMileposts = new Set<string>();
  const struckPlayerIds = new Set<string>();
  for (const entry of restrictions as Array<Partial<MovementRestriction> | null>) {
    if (!entry) continue;
    const zone: string[] = Array.isArray(entry.zone) ? entry.zone : [];
    if (entry.type === "half_rate") {
      for (const key of zone) halfRateZone.add(key);
    } else if (entry.type === "blocked_terrain") {
      for (const key of zone) blockedMileposts.add(key);
    } else if (entry.type === "no_movement_on_player_rail" && typeof entry.targetPlayerId === "string") {
      struckPlayerIds.add(entry.targetPlayerId);
    }
  }
  return { halfRateZone, blockedMileposts, struckPlayerIds };
}

/** True when the rules restrict nothing. */
export function hasNoMovementEventRules(rules: MovementEventRules): boolean {
  return (
    rules.halfRateZone.size === 0 &&
    rules.blockedMileposts.size === 0 &&
    rules.struckPlayerIds.size === 0
  );
}

/**
 * Apply half rate to what is left of the turn: the remaining movement is
 * halved, fractions rounded up. Does nothing when half rate already applies.
 */
export function applyHalfRate(state: MovementBudgetState): MovementBudgetState {
  if (state.halfRateApplied) return state;
  return { remaining: halveMovement(state.remaining), halfRateApplied: true };
}

/**
 * The budget a move starts with when the train stands on `fromKey`. A train
 * standing in a half-rate zone moves at half rate: at the start of a turn that
 * gives 5 or 6 mileposts, and when the event was drawn after the train had
 * already moved this turn it halves what was left.
 */
export function beginMoveAt(
  state: MovementBudgetState,
  fromKey: string,
  rules: MovementEventRules,
): MovementBudgetState {
  return rules.halfRateZone.has(fromKey) ? applyHalfRate(state) : state;
}

/**
 * Move one edge to the milepost `toKey`. A paid edge uses one milepost; a free
 * edge (inside a major city's red area, or a ferry line) uses none. A train
 * that enters a half-rate zone has what is left AFTER that step halved.
 *
 * @returns the budget after the step, or null when there is no movement left for it.
 */
export function enterMilepost(
  state: MovementBudgetState,
  toKey: string,
  isFreeEdge: boolean,
  rules: MovementEventRules,
): MovementBudgetState | null {
  let next: MovementBudgetState = state;
  if (!isFreeEdge) {
    if (state.remaining < 1) return null;
    next = { remaining: state.remaining - 1, halfRateApplied: state.halfRateApplied };
  }
  return rules.halfRateZone.has(toKey) ? applyHalfRate(next) : next;
}

/** True when an event forbids moving into the milepost. */
export function isMilepostBlocked(toKey: string, rules: MovementEventRules): boolean {
  return rules.blockedMileposts.has(toKey);
}

/**
 * True when an event forbids moving along a track edge with these owners: the
 * edge is somebody's track and every owner is under a Rail Strike. Ownerless
 * edges (a major city's red area, ferry lines) are never struck.
 */
export function isEdgeStruck(
  ownerPlayerIds: Iterable<string> | undefined,
  rules: MovementEventRules,
): boolean {
  if (rules.struckPlayerIds.size === 0 || ownerPlayerIds === undefined) return false;
  let owners = 0;
  for (const ownerId of ownerPlayerIds) {
    owners++;
    if (!rules.struckPlayerIds.has(ownerId)) return false;
  }
  return owners > 0;
}

/**
 * The budget state at the current point of a turn, from the turn's
 * `movement_history.movement_path`.
 *
 * - No segments yet: the train type's allowance, halved up front when
 *   `startsAtHalfRate`. (A ferry crossing does not use this: it is a move, and
 *   the route search halves the budget when it takes the ferry edge.)
 * - Otherwise the state the server stored on the last segment.
 * - A last segment without stored state (written before #313): the allowance
 *   minus the summed segment costs.
 *
 * A stored `remainingAfter` is never trusted above the train type's speed.
 */
export function readTurnMovementState(
  trainType: TrainType,
  movementPath: unknown,
  startsAtHalfRate: boolean = false,
): MovementBudgetState {
  const modifiers: MovementAllowanceModifier[] = startsAtHalfRate ? [halfRateAllowance] : [];
  const segments: unknown[] = Array.isArray(movementPath) ? movementPath : [];
  const last = segments.length > 0
    ? (segments[segments.length - 1] as { remainingAfter?: unknown; halfRate?: unknown } | null)
    : null;
  const stored: unknown = last?.remainingAfter;
  const storedHalfRate: unknown = last?.halfRate;
  if (typeof stored === "number" && Number.isFinite(stored) && typeof storedHalfRate === "boolean") {
    const remaining = Math.min(getTrainSpeed(trainType), Math.max(0, Math.floor(stored)));
    return { remaining, halfRateApplied: storedHalfRate };
  }
  return {
    remaining: computeRemainingMovement(trainType, segments, modifiers),
    halfRateApplied: startsAtHalfRate,
  };
}

/**
 * Mileposts left this turn for a train standing at `position`, with the active
 * event rules applied: what `moveTrainForUser` would start the next move with.
 */
export function remainingMovementAt(
  trainType: TrainType,
  movementPath: unknown,
  position: { row: number; col: number } | null,
  rules: MovementEventRules,
): number {
  const state = readTurnMovementState(trainType, movementPath);
  return position ? beginMoveAt(state, milepostKey(position), rules).remaining : state.remaining;
}

/** Why `walkMovePath` stopped before the end of the path. */
export enum MovePathStop {
  /** The whole path was walked. */
  None = 0,
  /** No movement left for the next milepost. */
  OutOfMovement = 1,
  /** The next milepost is blocked by an event (Snow). */
  BlockedMilepost = 2,
  /** The next edge is on track under a Rail Strike. */
  RailStrike = 3,
}

/**
 * Walk a given route (a list of mileposts, start first) under the event rules
 * and report how far the train gets. Used by the bot planner, which chooses
 * its own route, so that it stops where the server would refuse to go on.
 * The caller applies `beginMoveAt` first when the budget does not yet account
 * for the starting milepost.
 *
 * @param ownersOfEdge owners of the edge from path[i] to path[i + 1], when known.
 */
export function walkMovePath(
  path: ReadonlyArray<{ row: number; col: number }>,
  start: MovementBudgetState,
  rules: MovementEventRules,
  ownersOfEdge?: (index: number) => Iterable<string> | undefined,
): { edgesTravelled: number; state: MovementBudgetState; stoppedBy: MovePathStop } {
  const majorCityLookup = getMajorCityLookup();
  // Milepost keys are built here ("row,col", the zone key format) rather than
  // with the trackUsageFees helpers, so that this function, which the bot
  // planners call, does not depend on a module their tests replace.
  const ferryPairs = getFerryPairKeys();
  let state: MovementBudgetState = start;
  for (let i = 0; i < path.length - 1; i++) {
    const fromKey = milepostKey(path[i]);
    const toKey = milepostKey(path[i + 1]);
    if (isMilepostBlocked(toKey, rules)) {
      return { edgesTravelled: i, state, stoppedBy: MovePathStop.BlockedMilepost };
    }
    if (isEdgeStruck(ownersOfEdge?.(i), rules)) {
      return { edgesTravelled: i, state, stoppedBy: MovePathStop.RailStrike };
    }
    const fromCity = majorCityLookup.get(fromKey);
    const isFree =
      ferryPairs.has(`${fromKey}|${toKey}`) ||
      (fromCity !== undefined && fromCity === majorCityLookup.get(toKey));
    const next = enterMilepost(state, toKey, isFree, rules);
    if (!next) {
      return { edgesTravelled: i, state, stoppedBy: MovePathStop.OutOfMovement };
    }
    state = next;
  }
  return { edgesTravelled: Math.max(0, path.length - 1), state, stoppedBy: MovePathStop.None };
}

/** "row,col": the key format of the stored event zones. */
function milepostKey(node: { row: number; col: number }): string {
  return `${node.row},${node.col}`;
}

function getFerryEdgeKeys(): Set<string> {
  return new Set<string>(getFerryEdges().map((ferry) => edgeKey(ferry.pointA, ferry.pointB)));
}

/** Both directions of every ferry line, as "row,col|row,col". */
function getFerryPairKeys(): Set<string> {
  const pairs = new Set<string>();
  for (const ferry of getFerryEdges()) {
    pairs.add(`${milepostKey(ferry.pointA)}|${milepostKey(ferry.pointB)}`);
    pairs.add(`${milepostKey(ferry.pointB)}|${milepostKey(ferry.pointA)}`);
  }
  return pairs;
}

// ── City mileposts ───────────────────────────────────────────────────────────

const CITY_TERRAINS: readonly TerrainType[] = [
  TerrainType.MajorCity,
  TerrainType.MediumCity,
  TerrainType.SmallCity,
];

/**
 * True when the grid position is a city milepost: a major city centre or
 * outpost, a medium city or a small city. A ferry port is not a city, even
 * when it carries a city's name (the Newcastle port next to Newcastle).
 */
export function isCityMilepost(row: number, col: number): boolean {
  const point = loadGridPoints().get(`${row},${col}`);
  return point !== undefined && CITY_TERRAINS.includes(point.terrain);
}

/** True when the grid position is a city milepost of the named city. */
export function isCityMilepostOf(row: number, col: number, cityName: string): boolean {
  return isCityMilepost(row, col) && isPositionAtCity(row, col, cityName, loadGridPoints());
}

// ── Ferry and reversal rules (issue #314) ────────────────────────────────────

type Milepost = { row: number; col: number };

/** How a route search may use ferry lines. */
export enum FerryAccess {
  /** No ferry line may be used. */
  None = 0,
  /**
   * A ferry line may be the first edge of the route only: the train began the
   * turn on the port and has not moved yet. Taking it puts the turn at half rate.
   */
  FromStart = 1,
  /**
   * Ferry lines are free edges anywhere. Not a legal way to move; used only to
   * tell "the ferry rule stands in the way" apart from "too far".
   */
  Unrestricted = 2,
}

/** True when the two mileposts are the two ports of one ferry line. */
export function isFerryCrossing(a: Milepost, b: Milepost): boolean {
  return getFerryPairKeys().has(`${milepostKey(a)}|${milepostKey(b)}`);
}

/**
 * True when the milepost is a ferry port: an end of a ferry line (which
 * includes Dublin and Belfast, whose terrain is a city) or ferry-port terrain.
 */
export function isFerryPortMilepost(row: number, col: number): boolean {
  const key = `${row},${col}`;
  if (loadGridPoints().get(key)?.terrain === TerrainType.FerryPort) return true;
  return getFerryEdges().some(
    (ferry) => milepostKey(ferry.pointA) === key || milepostKey(ferry.pointB) === key,
  );
}

/** True where a train may reverse direction: a city milepost or a ferry port. */
export function canReverseAt(row: number, col: number): boolean {
  return isCityMilepost(row, col) || isFerryPortMilepost(row, col);
}

function lastSegmentOf(movementPath: unknown): { to?: unknown; arrivedFrom?: unknown } | null {
  if (!Array.isArray(movementPath) || movementPath.length === 0) return null;
  const last: unknown = movementPath[movementPath.length - 1];
  return last !== null && typeof last === "object" ? (last as { to?: unknown; arrivedFrom?: unknown }) : null;
}

function asMilepost(value: unknown): Milepost | null {
  const candidate = value as { row?: unknown; col?: unknown } | null | undefined;
  if (!candidate || !Number.isInteger(candidate.row) || !Number.isInteger(candidate.col)) return null;
  return { row: candidate.row as number, col: candidate.col as number };
}

/** True when the turn's `movement_history.movement_path` holds at least one move. */
export function hasMovedThisTurn(movementPath: unknown): boolean {
  return Array.isArray(movementPath) && movementPath.length > 0;
}

/**
 * The milepost the train may not move straight back to, or null when its
 * first step is unrestricted.
 *
 * The train's direction is the last edge it travelled: the `arrivedFrom` of
 * the last segment of this turn, or of the previous turn when it has not moved
 * yet this turn. There is no restriction when
 * - the train stands on a city milepost or a ferry port,
 * - it did not move this turn or the previous one (a train that stood still
 *   for a whole turn may leave in either direction: the rulebook's
 *   backtracking, which costs a turn),
 * - the last segment does not end where the train stands, or carries no
 *   `arrivedFrom` (a first placement, or a row written before #314).
 */
export function reversalBlockedMilepost(args: {
  position: Milepost | null;
  thisTurnPath: unknown;
  previousTurnPath: unknown;
}): Milepost | null {
  const { position } = args;
  if (!position) return null;
  const last = lastSegmentOf(args.thisTurnPath) ?? lastSegmentOf(args.previousTurnPath);
  if (!last) return null;
  const endedAt = asMilepost(last.to);
  if (!endedAt || endedAt.row !== position.row || endedAt.col !== position.col) return null;
  const arrivedFrom = asMilepost(last.arrivedFrom);
  if (!arrivedFrom) return null;
  if (arrivedFrom.row === position.row && arrivedFrom.col === position.col) return null;
  return canReverseAt(position.row, position.col) ? null : arrivedFrom;
}

/**
 * The same answer for a route just travelled (mileposts, start first): the
 * milepost before the last one, unless the route ends where a train may
 * reverse. Used by the bot planner to carry the train's direction from one
 * planned move to the next.
 */
export function reversalBlockedAfterPath(path: ReadonlyArray<Milepost>): Milepost | null {
  if (path.length < 2) return null;
  const end = path[path.length - 1];
  const before = path[path.length - 2];
  return canReverseAt(end.row, end.col) ? null : { row: before.row, col: before.col };
}

/**
 * Carry a planned move into a bot snapshot's movement-rule state, so that the
 * next move planned in the same turn follows the ferry and reversal rules.
 */
export function recordPlannedMove(
  train: { movedThisTurn?: boolean; reversalBlockedTo?: Milepost | null },
  path: ReadonlyArray<Milepost>,
): void {
  train.movedThisTurn = true;
  train.reversalBlockedTo = reversalBlockedAfterPath(path);
}

// ── Route search ─────────────────────────────────────────────────────────────

export type MovePath = {
  /** Edges from the start to the destination, in travel order. */
  path: PathEdge[];
  /** Opponents whose track the path runs on. */
  ownersUsed: Set<string>;
  /** Mileposts the path costs (paid edges; half rate does not change this count). */
  mileposts: number;
  /** The movement budget once the train is at the destination. */
  stateAfter: MovementBudgetState;
  /** True when the route crosses a ferry. */
  usedFerry: boolean;
};

type SearchState = {
  nodeKey: string;
  /** Movement left on arriving at the node. */
  remaining: number;
  halfRateApplied: boolean;
  /** Paid edges walked so far. */
  mileposts: number;
  /**
   * The node the next step may not lead back to: the one this node was reached
   * from, or null on a node where a train may reverse.
   */
  cameFrom: string | null;
};

/** Edge key between two node keys, in the encoding `buildUnionTrackGraph` uses. */
function edgeKeyOf(aKey: string, bKey: string): string {
  return edgeKey(parseNodeKey(aKey), parseNodeKey(bKey));
}

function budgetOf(state: SearchState): MovementBudgetState {
  return { remaining: state.remaining, halfRateApplied: state.halfRateApplied };
}

/**
 * Find the route a move is charged for: among the routes on the union track
 * graph that fit in the `maxMileposts` left this turn, the one that runs on
 * the fewest opponent-owned edges, and among those the one that leaves the
 * most movement.
 *
 * So a player's own (longer) route is used when it fits in the movement left,
 * and a shorter route over opponent track only when the own route does not
 * fit. The path that is counted is the path that is charged for.
 *
 * `allowedOpponentIds`, when given, limits whose track the route may run on:
 * an edge with an owner who is neither the current player nor in the set is
 * not used at all. `moveTrainForUser` passes the opponents the client's fee
 * preview shows plus those already paid this turn, so a move never owes a fee
 * the player was not shown.
 *
 * Milepost counting matches the client and the bots
 * (`computeEffectivePathLength`): an edge inside one major city's red area is
 * free, every other track edge is one milepost.
 *
 * Ferry lines (#314) are used as `ferryAccess` says, by default not at all.
 * With `FerryAccess.FromStart` a ferry line may be the first edge of the
 * route: the crossing uses no milepost and halves what is left of the turn
 * (once per turn, like any half rate).
 *
 * Reversal (#314): no step of the route goes straight back to the milepost the
 * train just came from, unless it stands on a city milepost or a ferry port
 * (`canReverseAt`). `noReturnTo`, when given, is that milepost for the first
 * step: the one the train last arrived from (`reversalBlockedMilepost`).
 *
 * Event rules (#313), when given: the route never enters a blocked milepost,
 * never uses track under a Rail Strike, and entering a half-rate zone halves
 * what is left (`enterMilepost`). `maxMileposts` and `halfRateApplied` are the
 * budget the move starts with, i.e. after `beginMoveAt` for the start milepost.
 * Without event rules "most movement left" is "fewest mileposts".
 *
 * The two limits combine: a detour around a blocked milepost or struck track
 * may still only use track of an allowed opponent.
 *
 * @returns the path, or null when no allowed route fits.
 */
export function findMovePathWithinBudget(args: {
  allTracks: PlayerTrackState[];
  from: { row: number; col: number };
  to: { row: number; col: number };
  currentPlayerId: string;
  maxMileposts: number;
  allowedOpponentIds?: ReadonlySet<string>;
  /** True when this turn's movement has already been halved. */
  halfRateApplied?: boolean;
  eventRules?: MovementEventRules;
  /** How ferry lines may be used. Default: not at all. */
  ferryAccess?: FerryAccess;
  /** The milepost the first edge of the route may not lead to (no reversal). */
  noReturnTo?: { row: number; col: number } | null;
}): MovePath | null {
  const budget = Math.max(0, Math.floor(args.maxMileposts));
  const rules = args.eventRules ?? NO_MOVEMENT_EVENT_RULES;
  const startKey = nodeKey(args.from);
  const goalKey = nodeKey(args.to);
  const start: SearchState = {
    nodeKey: startKey,
    remaining: budget,
    halfRateApplied: args.halfRateApplied === true,
    mileposts: 0,
    cameFrom: args.noReturnTo ? nodeKey(args.noReturnTo) : null,
  };
  if (startKey === goalKey) {
    return { path: [], ownersUsed: new Set(), mileposts: 0, stateAfter: budgetOf(start), usedFerry: false };
  }
  const ferryAccess: FerryAccess = args.ferryAccess ?? FerryAccess.None;
  const reversalPoints = new Map<string, boolean>();
  const mayReverseAt = (key: string): boolean => {
    let known = reversalPoints.get(key);
    if (known === undefined) {
      const node = parseNodeKey(key);
      known = canReverseAt(node.row, node.col);
      reversalPoints.set(key, known);
    }
    return known;
  };

  const { adjacency, edgeOwners } = buildUnionTrackGraph({ allTracks: args.allTracks });
  const majorCityLookup = getMajorCityLookup();
  const ferryKeys = getFerryEdgeKeys();

  // Search over (node, movement left, half rate) states in increasing order of
  // (opponent edges, movement used up). "Used up" is the starting budget minus
  // what is left, so it includes what half rate took away; it never decreases
  // along a route. Both are small integers, so the queue is an array of
  // buckets indexed by `opponentEdges * (budget + 1) + usedUp`.
  const stateKey = (s: SearchState): string =>
    `${s.nodeKey}|${s.remaining}|${s.halfRateApplied ? 1 : 0}|${s.cameFrom ?? ""}`;
  const buckets: SearchState[][] = [[start]];
  // Fewest opponent edges each state has been queued with so far.
  const fewestOpponentEdges = new Map<string, number>([[stateKey(start), 0]]);
  const parent = new Map<string, SearchState>();
  const settled = new Set<string>();

  for (let priority = 0; priority < buckets.length; priority++) {
    const bucket = buckets[priority];
    if (!bucket) continue;
    const opponentEdges = Math.floor(priority / (budget + 1));

    // A free edge queues its target into the bucket being read, so the length
    // is re-read on every pass.
    for (let i = 0; i < bucket.length; i++) {
      const current = bucket[i];
      const currentKey = stateKey(current);
      // Skip an entry that was later re-queued with fewer opponent edges.
      if (fewestOpponentEdges.get(currentKey) !== opponentEdges) continue;
      if (settled.has(currentKey)) continue;
      settled.add(currentKey);

      if (current.nodeKey === goalKey) {
        return buildMovePath(current, parent, stateKey, edgeOwners, args.currentPlayerId);
      }

      // `start` is settled first and never re-queued, so this is the first edge.
      const isFirstEdge = current === start;
      for (const nextKey of adjacency.get(current.nodeKey) ?? []) {
        if (isMilepostBlocked(nextKey, rules)) continue;
        if (nextKey === current.cameFrom) continue;
        const eKey = edgeKeyOf(current.nodeKey, nextKey);
        const isFerry = ferryKeys.has(eKey);
        if (isFerry && ferryAccess !== FerryAccess.Unrestricted) {
          if (ferryAccess === FerryAccess.None || !isFirstEdge) continue;
        }
        const owners = edgeOwners.get(eKey);
        if (isEdgeStruck(owners, rules)) continue;
        // An edge with an owner who is neither the mover nor an allowed opponent
        // is not used, even when the mover co-owns it.
        if (owners !== undefined && args.allowedOpponentIds !== undefined) {
          const allowed = args.allowedOpponentIds;
          const hasUnshownOwner = Array.from(owners).some(
            (ownerId) => ownerId !== args.currentPlayerId && !allowed.has(ownerId),
          );
          if (hasUnshownOwner) continue;
        }

        const isFree = isFerry || isIntraCityEdge(current.nodeKey, nextKey, majorCityLookup);
        const entered = enterMilepost(budgetOf(current), nextKey, isFree, rules);
        if (!entered) continue;
        // A ferry crossing puts the rest of the turn at half rate.
        const after =
          isFerry && ferryAccess === FerryAccess.FromStart ? applyHalfRate(entered) : entered;

        const isOpponentOnly =
          owners !== undefined && owners.size > 0 && !owners.has(args.currentPlayerId);
        const next: SearchState = {
          nodeKey: nextKey,
          remaining: after.remaining,
          halfRateApplied: after.halfRateApplied,
          mileposts: current.mileposts + (isFree ? 0 : 1),
          cameFrom: mayReverseAt(nextKey) ? null : current.nodeKey,
        };
        const nextStateKey = stateKey(next);
        if (settled.has(nextStateKey)) continue;
        const nextOpponentEdges = opponentEdges + (isOpponentOnly ? 1 : 0);
        const queuedWith = fewestOpponentEdges.get(nextStateKey);
        if (queuedWith !== undefined && queuedWith <= nextOpponentEdges) continue;
        fewestOpponentEdges.set(nextStateKey, nextOpponentEdges);
        parent.set(nextStateKey, current);

        const nextPriority = nextOpponentEdges * (budget + 1) + (budget - next.remaining);
        if (!buckets[nextPriority]) buckets[nextPriority] = [];
        buckets[nextPriority].push(next);
      }
    }
  }

  return null;
}

function buildMovePath(
  goal: SearchState,
  parent: Map<string, SearchState>,
  stateKey: (s: SearchState) => string,
  edgeOwners: Map<string, Set<string>>,
  currentPlayerId: string,
): MovePath {
  const nodeKeys: string[] = [goal.nodeKey];
  let step: SearchState | undefined = parent.get(stateKey(goal));
  while (step) {
    nodeKeys.unshift(step.nodeKey);
    step = parent.get(stateKey(step));
  }

  const path: PathEdge[] = [];
  const ownersUsed = new Set<string>();
  const ferryKeys = getFerryEdgeKeys();
  let usedFerry = false;
  for (let i = 0; i < nodeKeys.length - 1; i++) {
    const eKey = edgeKeyOf(nodeKeys[i], nodeKeys[i + 1]);
    if (ferryKeys.has(eKey)) usedFerry = true;
    const owners = edgeOwners.get(eKey);
    const ownerPlayerIds = owners ? Array.from(owners) : [];
    for (const ownerId of ownerPlayerIds) {
      if (ownerId !== currentPlayerId) ownersUsed.add(ownerId);
    }
    path.push({ from: parseNodeKey(nodeKeys[i]), to: parseNodeKey(nodeKeys[i + 1]), ownerPlayerIds });
  }
  return { path, ownersUsed, mileposts: goal.mileposts, stateAfter: budgetOf(goal), usedFerry };
}

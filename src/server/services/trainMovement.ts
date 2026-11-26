import { buildUnionTrackGraph, PathEdge } from "../../shared/services/trackUsageFees";
import { getFerryEdges, getMajorCityLookup, isIntraCityEdge } from "../../shared/services/majorCityGroups";
import { isPositionAtCity } from "../../shared/services/cityPositionResolver";
import { getTrainSpeed } from "../../shared/services/trainProperties";
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
 * Adjusts a turn's movement allowance. Issue #313 (half rate after a ferry
 * crossing or in bad weather) plugs in here; none are applied yet.
 */
export type MovementAllowanceModifier = (allowance: number) => number;

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

/** Mileposts left this turn. Never negative. */
export function computeRemainingMovement(
  trainType: TrainType,
  movementPath: unknown,
  modifiers: readonly MovementAllowanceModifier[] = [],
): number {
  return Math.max(0, getTurnMovementAllowance(trainType, modifiers) - sumMovementUsed(movementPath));
}

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

export type MovePath = {
  /** Edges from the start to the destination, in travel order. */
  path: PathEdge[];
  /** Opponents whose track the path runs on. */
  ownersUsed: Set<string>;
  /** Mileposts the path costs. */
  mileposts: number;
};

type SearchState = { nodeKey: string; mileposts: number };

function toKey(node: { row: number; col: number }): string {
  return `${node.row},${node.col}`;
}

function parseKey(key: string): { row: number; col: number } {
  const [row, col] = key.split(",");
  return { row: Number(row), col: Number(col) };
}

function undirectedKey(aKey: string, bKey: string): string {
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

/**
 * Find the route a move is charged for: among the routes on the union track
 * graph that cost at most `maxMileposts`, the one that runs on the fewest
 * opponent-owned edges, and among those the one with the fewest mileposts.
 *
 * So a player's own (longer) route is used when it fits in the movement left,
 * and a shorter route over opponent track only when the own route does not
 * fit. The path that is counted is the path that is charged for.
 *
 * Milepost counting matches the client and the bots
 * (`computeEffectivePathLength`): an edge inside one major city's red area is
 * free, every other track edge is one milepost.
 *
 * A ferry edge is also free here. Ferry rules (stop at the port, cross at the
 * start of the next turn, then half rate) belong to issue #314; until then the
 * crossing itself must not use up movement, because a bot's first move after
 * reaching a port starts from the port it arrived at.
 *
 * @returns the path, or null when no route fits in `maxMileposts`.
 */
export function findMovePathWithinBudget(args: {
  allTracks: PlayerTrackState[];
  from: { row: number; col: number };
  to: { row: number; col: number };
  currentPlayerId: string;
  maxMileposts: number;
}): MovePath | null {
  const budget = Math.max(0, Math.floor(args.maxMileposts));
  const startKey = toKey(args.from);
  const goalKey = toKey(args.to);
  if (startKey === goalKey) {
    return { path: [], ownersUsed: new Set(), mileposts: 0 };
  }

  const { adjacency, edgeOwners } = buildUnionTrackGraph({ allTracks: args.allTracks });
  const majorCityLookup = getMajorCityLookup();
  const ferryKeys = new Set<string>(
    getFerryEdges().map((ferry) => undirectedKey(toKey(ferry.pointA), toKey(ferry.pointB))),
  );

  // Search over (node, mileposts used) states in increasing order of
  // (opponent edges, mileposts). Both are small integers, so the queue is an
  // array of buckets indexed by `opponentEdges * (budget + 1) + mileposts`.
  const stateKey = (s: SearchState): string => `${s.nodeKey}|${s.mileposts}`;
  const start: SearchState = { nodeKey: startKey, mileposts: 0 };
  const buckets: SearchState[][] = [[start]];
  // Fewest opponent edges each state has been queued with so far.
  const fewestOpponentEdges = new Map<string, number>([[stateKey(start), 0]]);
  const parent = new Map<string, SearchState>();
  // Fewest mileposts among a node's settled states. States settle in
  // increasing opponent-edge order, so a later state is only worth keeping
  // when it reaches the node with fewer mileposts than every earlier one.
  const settledMileposts = new Map<string, number>();

  for (let priority = 0; priority < buckets.length; priority++) {
    const bucket = buckets[priority];
    if (!bucket) continue;
    const opponentEdges = Math.floor(priority / (budget + 1));

    for (let i = 0; i < bucket.length; i++) {
      const current = bucket[i];
      // Skip an entry that was later re-queued with fewer opponent edges.
      if (fewestOpponentEdges.get(stateKey(current)) !== opponentEdges) continue;
      const best = settledMileposts.get(current.nodeKey);
      if (best !== undefined && best <= current.mileposts) continue;
      settledMileposts.set(current.nodeKey, current.mileposts);

      if (current.nodeKey === goalKey) {
        return buildMovePath(current, parent, stateKey, edgeOwners, args.currentPlayerId);
      }

      for (const nextKey of adjacency.get(current.nodeKey) ?? []) {
        const eKey = undirectedKey(current.nodeKey, nextKey);
        const isFree =
          ferryKeys.has(eKey) || isIntraCityEdge(current.nodeKey, nextKey, majorCityLookup);
        const nextMileposts = current.mileposts + (isFree ? 0 : 1);
        if (nextMileposts > budget) continue;

        const nextBest = settledMileposts.get(nextKey);
        if (nextBest !== undefined && nextBest <= nextMileposts) continue;

        const owners = edgeOwners.get(eKey);
        const isOpponentOnly =
          owners !== undefined && owners.size > 0 && !owners.has(args.currentPlayerId);
        const next: SearchState = { nodeKey: nextKey, mileposts: nextMileposts };
        const nextStateKey = stateKey(next);
        const nextOpponentEdges = opponentEdges + (isOpponentOnly ? 1 : 0);
        const queuedWith = fewestOpponentEdges.get(nextStateKey);
        if (queuedWith !== undefined && queuedWith <= nextOpponentEdges) continue;
        fewestOpponentEdges.set(nextStateKey, nextOpponentEdges);
        parent.set(nextStateKey, current);

        const nextPriority = nextOpponentEdges * (budget + 1) + nextMileposts;
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
  for (let i = 0; i < nodeKeys.length - 1; i++) {
    const owners = edgeOwners.get(undirectedKey(nodeKeys[i], nodeKeys[i + 1]));
    const ownerPlayerIds = owners ? Array.from(owners) : [];
    for (const ownerId of ownerPlayerIds) {
      if (ownerId !== currentPlayerId) ownersUsed.add(ownerId);
    }
    path.push({ from: parseKey(nodeKeys[i]), to: parseKey(nodeKeys[i + 1]), ownerPlayerIds });
  }
  return { path, ownersUsed, mileposts: goal.mileposts };
}

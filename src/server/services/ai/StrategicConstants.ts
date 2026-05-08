/**
 * StrategicConstants — Tunable constants for Medium-skill strategic context builder
 * and propose-acceptance gate.
 */

/** Number of turns a demand card must be held before it is flagged as stale */
export const HAND_STALE_THRESHOLD_TURNS = 10;

/** Maximum number of victory-target cities returned by buildVictoryTargets */
export const VICTORY_TARGETS_COUNT = 4;

/**
 * Hand-affinity hop radius: how many BFS hops away from a city a demand card
 * must be for it to count as "hand-affinity" toward that city.
 */
export const VICTORY_TARGET_HAND_AFFINITY_HOPS = 3;

/** Rolling window length for recentDeliveries income-velocity calculation */
export const RECENT_DELIVERIES_WINDOW = 5;

/**
 * Minimum score delta required for a proposed route to displace the status-quo.
 * propose_score must exceed status_quo_score + PROPOSE_MIN_SCORE_DELTA to be accepted.
 */
export const PROPOSE_MIN_SCORE_DELTA = 0;

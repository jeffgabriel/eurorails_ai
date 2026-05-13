# JIRA-223 — Affordability gate for trip selection (technical)

Companion to `jira-223-a1OpportunisticAffordabilityCheck-behavioral.md`. Read that first for scope and acceptance criteria.

## Current implementation

### Score-only affordability (DeterministicTripPlanner.ts)

The deterministic algorithm scores candidates as:

```ts
score = (payout − buildCost) − OCPT × turns
```

Build and turn counts come from `RouteDetourEstimator.simulateTrip`. There is no check that the bot's cash on hand can cover even the first leg's build cost. A candidate with `payout=28M, buildCost=30M, turns=10, OCPT=2` produces `score = −2 − 20 = −22`, which can still be top-1 in early game where most candidates score worse.

### Upgrade affordability gate (already in place)

`selectUpgradeTarget(currentTrainType, cash, tripBuildCost)` at `DeterministicTripPlanner.ts:~750` blocks emitting an `upgradeOnRoute` when `cash < upgradeCost + tripBuildCost`. This is the correct *shape* of an affordability gate — but it gates the upgrade decision only, not the underlying trip selection.

### a1-opportunistic pickup (MovementPhasePlanner)

The opportunistic pickup branch at `MovementPhasePlanner.ts:~160-200` accepts a pickup whenever the bot's current path passes through a supply city for an in-hand demand. It does not check that the bot can fund the rest of the trip.

### Post-LLM affordability gate (LLM path only)

`TripPlanner.ts:~407` checks `totalCost = upgradeCost + buildCostEstimate + usageFeeEstimate <= availableCash` and rejects the LLM's proposed plan if the bot can't afford it. The LLM retries with a hint. The deterministic path does not go through this gate (it returns directly at `TripPlanner.ts:~218`).

## Root cause

The deterministic algorithm's score function aggregates payout and cost into a single number. It conflates "this trip has positive lifetime value" with "the bot can execute this trip from its current cash position." A trip with positive long-run NET can still be unfundable if the bot must pay 30M of build before any delivery pays out.

## Fix plan

### 1. Cash-sequence simulation in `RouteDetourEstimator` (or a sibling helper)

Extend `simulateTrip` (or add `simulateTripCashFlow`) to return, in addition to `turnsToComplete` and `totalBuildCost`:

```ts
export interface TripSimulation {
  turnsToComplete: number;
  totalBuildCost: number;
  feasible: boolean;
  // NEW
  minCashHeadroom: number;  // signed; negative means cash dips below 0 at some point
  finalCash: number;        // cash at end of trip = startingCash + payouts − builds − fees
}
```

The simulator already walks turn-by-turn applying build budget caps. Tag each phase with its cash effect:

- Build phase: cash decreases by builtThisTurn.
- Move phase across opponent track: cash decreases by usage fee (if any).
- Stop phase, deliver: cash increases by payout for that demand.
- Stop phase, pickup: cash unchanged.

Track the running cash balance and the lowest point reached (`minCashHeadroom`). Return both.

### 2. Affordability filter in `DeterministicTripPlanner.scoreCandidate`

```ts
function scoreCandidate(candidate, startPos, snapshot, opts): ScoredCandidate {
  const sim = simulateTrip(startPos, candidate.stops, snapshot);
  if (!sim.feasible) return { ..., feasible: false };

  // NEW: affordability gate
  const startingCash = snapshot.bot.money;
  const minCash = startingCash + sim.minCashHeadroom;
  if (minCash < 0) {
    return { ..., feasible: false, infeasibleReason: `cash dips to ${minCash}M mid-trip (start=${startingCash}M)` };
  }

  const net = candidate.payout − sim.totalBuildCost;
  return { ..., score: net − opts.ocpt × sim.turnsToComplete, feasible: true };
}
```

Candidates that would put the bot in the red are marked `feasible: false` and dropped from ranking. This is the same shape as the existing simulator-feasibility check, just extended.

### 3. a1-opportunistic gate in `MovementPhasePlanner`

After the opportunistic-pickup eligibility check (the bot is at a supply city for an in-hand demand), simulate the cost to complete the rest of the trip from this position. If the bot's cash after the pickup is insufficient to fund the remaining build/fees before the next delivery, skip the pickup. This requires a small simulator call inline.

Specifically:

```ts
// Before applying opportunistic pickup at currentCity for loadType X
const remainingStops = activeRoute.stops.slice(activeRoute.currentStopIndex);
const sim = simulateTrip(snapshot.bot.position!, remainingStops, snapshot);
if (snapshot.bot.money + sim.minCashHeadroom < 0) {
  console.log(`${tag} a1-opportunistic skipped: cash ${snapshot.bot.money}M cannot fund remaining trip (min headroom ${sim.minCashHeadroom}M)`);
  return /* continue without pickup */;
}
```

### 4. Tunable: cash floor

Some games may want a small reserve (e.g. 5M for opponent track-use fees that are hard to pre-compute). Expose:

```ts
export const AFFORDABILITY_CASH_FLOOR_M = 0;  // strict — bot may dip to exactly 0
```

Setting it >0 forces a buffer.

### 5. Mercy borrow modeling (deferred)

If the bot can borrow per the rules (CLAUDE.md), the affordability gate could optionally allow a one-time +20M liquidity injection. Recommended deferred: default to non-borrow strict gate; revisit if the gate becomes too aggressive in real play.

## Test plan

### Unit tests in `DeterministicTripPlanner.test.ts`

1. **Affordable trip passes**: cash=50M, candidate with buildCost=30M, payout 40M → `feasible: true`.
2. **Unaffordable trip rejected**: cash=10M, candidate with buildCost=30M (front-loaded), payout 40M → `feasible: false` because cash dips to −20M before the delivery payout arrives.
3. **Boundary**: cash=30M, build=30M (exact match, dip to 0) → `feasible: true` (strict ≥ 0).
4. **Multi-leg cash flow**: cash=15M, build leg-1=10M, payout leg-1=20M, build leg-2=20M → `feasible: true` (intermediate payout funds leg 2).
5. **Same trip with payouts at the END only**: cash=15M, build leg-1=10M, build leg-2=20M, payout=combined-at-end 30M → `feasible: false` (cash dips to −15M between legs).
6. **Game b1dd75b7 reproduction**: cash=7M, candidate `pFish@Oslo + pFish@Oslo + dFish@Bern + dFish@Zurich`, build=~35M → `feasible: false`.

### Integration test in `MovementPhasePlanner.test.ts`

7. **a1-opportunistic skips pickup when affordability fails**: bot at Oslo with 5M cash, route requires 30M build to deliver → opportunistic pickup is NOT applied; bot continues without picking up; warn logged.

### Replay regression

Run `scripts/ai/spatial-prune-analysis.ts` against the historical log corpus. The strict-loss count must remain at 0; net delta should not regress meaningfully (some trips that were previously top-1 may now be filtered, but they were unaffordable so this is a correctness fix, not a quality regression).

## Risks

- **Over-conservative**: bots may refuse trips that are actually fundable via mercy borrow or via opponent track-use fees that arrive mid-trip. Mitigation: start with `AFFORDABILITY_CASH_FLOOR_M = 0` (no buffer); tighten only if real-game evidence shows the bot is stalling on viable trips.
- **Simulator extension scope**: adding cash flow to `simulateTrip` requires the simulator to know which stops are deliveries vs pickups (it already iterates stops by action, so this is small) and to read each demand's payout (currently in `RouteStop.payment`). One field to thread.
- **a1-opportunistic latency**: a per-pickup simulator call adds ~5-10ms. Acceptable.

## Verification before scheduling

- Confirm `RouteStop.payment` is reliably populated for deliver stops in production paths (it's set in `genSingles` / `genPairs` of the deterministic algorithm; verify LLM-emitted routes carry it through `applyPostPlanPipeline`).
- Confirm opponent track-use fees are not currently modeled in `simulateTrip`. If they're modeled, include them in cash flow; if not, document that the gate is conservative-by-omission.

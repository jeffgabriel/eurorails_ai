# JIRA-242 — Add `Early` to GameState (turns 4–25) and a flat +0.05 M/turn multi-delivery bonus to candidate scoring in Early and Mid (technical)

Companion to `jira-242-tripPlannerLacksEarlyGameExpansionBias-behavioral.md`. Builds on JIRA-241 (which introduced the persistent `gameState` field).

## Defect locus

- `src/shared/types/GameTypes.ts` — `GameState` enum is missing an `Early` member.
- `src/server/services/ai/victoryRules.ts` — `computeGameState` only knows about `Mid`/`End` and ignores `turnNumber`.
- `src/server/services/ai/ContextBuilder.ts` — caller does not pass `turnNumber` to `computeGameState`.
- `src/server/services/ai/DeterministicTripPlanner.ts` — `planTripDeterministic` has no expansion bias; multi-delivery candidates win or lose purely on raw `aggregateScore`.

## Fix shape

### 1. Extend the enum

```ts
// src/shared/types/GameTypes.ts
export enum GameState {
  Initial = 'initial',
  Early   = 'early',   // NEW
  Mid     = 'mid',
  End     = 'end',
}
```

No existing call sites read `GameState.Initial` directly (still implicit), so adding `Early` before `Mid` is purely additive.

### 2. Make `computeGameState` turn-aware

```ts
// src/server/services/ai/victoryRules.ts
//
// Naming note: the module name "victoryRules" still fits — `computeGameState`
// already lives here and the new turn-based transitions are part of the same
// concern (game-phase state machine). A rename is out of scope for this fix.

export function computeGameState(
  context: { money: number; turnNumber: number },
  memory: BotMemoryState,
): GameState {
  if (memory.gameState === GameState.End) return GameState.End;
  if (context.money > END_GAME_ENTRY_CASH) return GameState.End;
  if (context.turnNumber > 25) return GameState.Mid;
  if (context.turnNumber >= 4) return GameState.Early;
  return GameState.Initial;
}
```

The `Early → Mid` transition does not need latching — turn numbers only increase, so once `turnNumber > 25` the function returns `Mid` deterministically thereafter (or `End` if cash crosses 200M, which takes precedence).

### 3. Pass `turnNumber` through `ContextBuilder`

```ts
// src/server/services/ai/ContextBuilder.ts
// (inside makeContext, where computeGameState is already invoked from JIRA-241)
const gamePhase = computeGameState(
  { money: snapshot.bot.money, turnNumber: turnNumberSomehow }, // see note below
  memoryForPhase,
);
```

`turnNumber` is already on `GameContext` and is computed earlier in `makeContext` (read from `memory.turnNumber` or equivalent). Confirm at implementation time which local variable holds it before the `computeGameState` call site.

### 4. Add the expansion bonus pass in `planTripDeterministic`

```ts
// src/server/services/ai/DeterministicTripPlanner.ts

/**
 * JIRA-242: Flat bonus added to multi-delivery candidates during Early/Mid
 * to encourage controlled expansion (consume more cards per pickup-city visit).
 *
 * Applied AFTER computeAggregateScore (so the chained look-ahead is reflected)
 * and BEFORE applyEndStateScoring (so End-state substitution still wins
 * outright). In End state the substitution overwrites aggregateScore wholesale,
 * so this bonus has no End-state effect.
 */
export const EXPANSION_MULTI_DELIVERY_BONUS_M_PER_TURN = 0.05;

function applyExpansionBonus(c: ScoredCandidate): void {
  const deliveryCount = c.stops.filter(s => s.action === 'deliver').length;
  if (deliveryCount >= 2) {
    c.aggregateScore += EXPANSION_MULTI_DELIVERY_BONUS_M_PER_TURN;
  }
}

// In planTripDeterministic, after the computeAggregateScore loop:
if (
  context.gameState === GameState.Early ||
  context.gameState === GameState.Mid
) {
  for (const c1 of feasible) {
    applyExpansionBonus(c1);
  }
}

// Then the existing JIRA-241 End-state pass runs:
if (context.gameState === GameState.End) {
  for (const c1 of feasible) {
    applyEndStateScoring(c1, context);
  }
}
```

`deliveryCount >= 2` is the trigger: singles get nothing; pairs and triples each get the same flat bonus (per design — flat, not per-extra-delivery). End state is excluded explicitly since its scoring substitution replaces `aggregateScore`.

## Test coverage

### `victoryRules.test.ts` (extend)

- AC1 — `computeGameState({ money: 50, turnNumber: 1 }, { gameState: undefined })` → `Initial`.
- AC1 — `{ money: 50, turnNumber: 3 }` → `Initial`.
- AC1 — `{ money: 50, turnNumber: 4 }` → `Early`.
- AC1 — `{ money: 50, turnNumber: 25 }` → `Early`.
- AC1 — `{ money: 50, turnNumber: 26 }` → `Mid`.
- AC1 — `{ money: 250, turnNumber: 10 }` → `End` (cash trigger beats turn-based).
- AC1 — `{ money: 50, turnNumber: 10 }, { gameState: End }` → `End` (latched).

### `DeterministicTripPlanner.test.ts` (extend)

- AC2 — In `Early`, two candidates: A (single delivery, `aggregateScore=0.18` pre-bonus) and B (pair, two `deliver` stops, `aggregateScore=0.17` pre-bonus). After the bonus pass, A=0.18, B=0.22. Verify by calling the existing scoring path or by exposing `applyExpansionBonus` directly.
- AC3 — Same fixture in `Early`: A's score after the bonus pass is unchanged (0.18).
- AC4 — Same fixture in `Mid`: B beats A (bonus fires identically in Mid).
- AC5 — Same fixture in `End`: bonus does NOT fire (gated out), then `applyEndStateScoring` substitutes. Verify by spying on the bonus path or by checking `aggregateScore` equals the end-state formula's output (no +0.05 leftover).
- AC6 — Same fixture at `gameState=Initial` (turn 3): bonus does NOT fire; A=0.18, B=0.17.
- AC7 — Triple candidate (3 `deliver` stops): bonus is still +0.05 flat, not +0.10 (verifies flat-not-scaling behavior).

### Regression — `8738866e.t6.integration.test.ts` (new file)

Reconstruct the s2 t6 snapshot from `logs/game-8738866e-0f51-488a-bff1-a5fab6b80ff1.ndjson`:

- `snapshot.bot.money = 40`
- `snapshot.bot.position` ≈ row 32 col 53 (post-Flowers-delivery position from log)
- `snapshot.bot.existingSegments` = Holland-direction segments laid in turns 2–5 (extract from the actual log)
- `context.turnNumber = 6` → ContextBuilder yields `gameState = Early`
- `context.demands` = the 9 demand cards from t6's `demandCards`, normalized with the planner's supply-variants enabled (so Birmingham is a China supply variant)
- Run `planTripDeterministic`

Assert: `result.route.stops` contains both `Iron@Birmingham` and `China@Birmingham` (in either pickup order). The single-Iron route should NOT be the top pick.

## Rollout / migration

- The `Early` enum value is purely additive — existing `BotMemoryState.gameState` deserializes safely; existing `switch (state)` blocks (if any) get a typescript `never`-fallthrough warning only if they're exhaustive, which is desirable.
- `computeGameState`'s signature now requires `turnNumber`. All call sites (one — `ContextBuilder.makeContext`) update in the same PR.
- `EXPANSION_MULTI_DELIVERY_BONUS_M_PER_TURN = 0.05` is a module-level constant in `DeterministicTripPlanner.ts`. Easy to tune after observing post-fix games.
- No data migration. Existing persisted memories with `gameState = 'mid'` or `'end'` continue to work; new turns produce `'early'` only when the bot is mid-game on a fresh turn-3-to-4 transition.

## Out of scope

- Renaming `victoryRules.ts` despite its expanded role — leave the name.
- Initial → Early transition formalization beyond turn-number boundary (no setup-turn-aware logic).
- Per-extra-delivery scaling (triple > pair). Flat bonus only.
- Ferry-specific cost adjustments — rejected during design.
- Tuning the 0.05 magnitude or the 25-turn boundary; these are spec'd as-is and revisited after live games.
- Removing or reshaping JIRA-241's `applyEndStateScoring` — left alone.

## Relationship to JIRA-241

JIRA-241 introduced the `gameState` field, the `computeGameState` function, the `End` latching rule, and the end-state scoring substitution. JIRA-242 extends every one of those touch points additively:

- `GameState` gains `Early`.
- `computeGameState` gains turn-based Early/Mid transitions.
- `ContextBuilder` passes one more field through.
- `planTripDeterministic` gains a bonus pass that fires in `Early` and `Mid` and is harmless in `End` (overwritten by `applyEndStateScoring`).

No code from JIRA-241 is reverted or rewritten.

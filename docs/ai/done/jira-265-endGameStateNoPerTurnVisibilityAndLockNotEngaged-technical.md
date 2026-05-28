# JIRA-265 — Surface per-turn end-game state into NDJSON via a new `composition.endGame` field; move the `endGameLocked` latch from `planTripDeterministic` into `ContextBuilder` so it engages on every turn (not just replan turns); align `gamePhase` display with `gameState=end` (technical)

Companion to `jira-265-endGameStateNoPerTurnVisibilityAndLockNotEngaged-behavioral.md`.

Three coordinated changes. Layer 1 (visibility) is the must-have and unblocks future investigation. Layer 2 (latch placement) is the root-cause fix for "endGameLocked is null in every log entry". Layer 3 (display alignment) prevents the confusing "Mid Game | Cash: 255M" output.

## Layer 1 — Per-turn `composition.endGame` field in NDJSON

**Defect locus.** `src/server/services/ai/GameLogger.ts` (`GameTurnLogEntry` shape); `src/server/services/ai/AIStrategyEngine.ts` (turn-log build site around `:1019-1021`); `src/server/services/ai/victoryRules.ts` (`findFinalVictoryRoute` — return shape needs to expose skip reasons for the null path).

### Step 1a — Change `findFinalVictoryRoute` return shape

Currently returns `FinalVictoryRoute | null`. Change to a discriminated union:

```ts
// victoryRules.ts
export type FinalVictoryOutcome =
  | { outcome: 'fire'; route: FinalVictoryRoute }
  | { outcome: 'skip'; reason: 'no_demands' | 'victory_met' | 'no_feasible_demands' | 'no_route_covers_gap'; cashGap?: number; connectorCost?: number; majorsGap?: number };

export function findFinalVictoryRoute(...): FinalVictoryOutcome { ... }
```

The four `console.log('[final-victory] skip: ...')` lines (332, 344, 364, 461) become carried-through structured returns. The lines themselves can stay (cheap interactive debugging) but the caller now has the structured reason too.

Caller at `AIStrategyEngine.ts:302` updates from `if (finalVictoryRoute) { ... }` to `if (result.outcome === 'fire') { ... }` etc.

### Step 1b — Define `EndGameTrace` shape

```ts
// shared/types/GameTypes.ts (or a new endGameTrace.ts)
export interface EndGameTrace {
  /** True when context.gameState === 'end'. False otherwise; the rest of the fields may be omitted. */
  inEndGame: boolean;
  /** Current value of memory.endGameLocked (after this turn's mutation, if any). */
  endGameLocked: boolean;
  /** Cash gap to victory threshold ($250M): max(0, 250 - cash). */
  cashGapM: number;
  /** Major-city gap to victory (7 connected): max(0, 7 - connectedCount). */
  majorsGap: number;
  /** The cheapest majorsGap unconnected majors needed to close the city condition. Each entry's costM is estimateTrackCost from current network. */
  cheapestConnectors: Array<{ cityName: string; costM: number }>;
  /** cashGapM + sum(cheapestConnectors.costM) — the total build-and-earn required to win. */
  fullWinCostM: number;
  /** Per-turn output of findFinalVictoryRoute. fire = override candidate; skip = reason for not finding one. */
  victoryRouteProjection:
    | { outcome: 'fire'; stops: string[]; turns: number; buildM: number; payoutM: number; cashAtVictory: number; majorsAtVictory: number; appliedOverride: boolean }
    | { outcome: 'skip'; reason: string };
  /** Whether the bot's current activeRoute (if any) will clinch on completion. Computed from the route's projected cash + connector deliveries. */
  activePlanProjection?: {
    willClinch: boolean;
    projectedCash: number;
    projectedMajors: number;
    turnsRemaining: number;
  };
}
```

### Step 1c — Populate per turn in `AIStrategyEngine`

In `AIStrategyEngine.takeTurn` (or wherever the turn-log entry is constructed), compute `endGameTrace` once per turn:

```ts
const inEndGame = context.gameState === GameState.End;
let endGameTrace: EndGameTrace | undefined;
if (inEndGame) {
  const cashGapM = Math.max(0, 250 - context.money);
  const majorsGap = Math.max(0, 7 - context.connectedMajorCities.length);
  const cheapestConnectors = context.unconnectedMajorCities
    .slice(0, majorsGap)
    .map(e => ({ cityName: e.cityName, costM: e.estimatedCost }));
  const fullWinCostM = cashGapM + cheapestConnectors.reduce((s, c) => s + c.costM, 0);
  const fvResult = findFinalVictoryRoute(snapshot, context, memory); // already called below; reuse
  // Build projection from result; activePlanProjection from activeRoute if set.
  endGameTrace = { inEndGame: true, endGameLocked: !!memory.endGameLocked, cashGapM, majorsGap, cheapestConnectors, fullWinCostM, victoryRouteProjection: ..., activePlanProjection: ... };
}
```

Attach to the turn-log entry:

```ts
return {
  ...existingTurnLogFields,
  composition: { ...existingComposition, endGame: endGameTrace },
};
```

After the fix, a reader can `jq -c 'select(.gameState=="end") | .composition.endGame' logs/game-<id>.ndjson` and see one structured object per turn.

## Layer 2 — Move `endGameLocked` latch from `planTripDeterministic` to `ContextBuilder`

**Defect locus.** `src/server/services/ai/DeterministicTripPlanner.ts:1671-1684` (current latch site, fires only on replan turns); `src/server/services/ai/ContextBuilder.ts` (target site, runs every turn alongside `computeGameState` for `gameState=end`).

The current latch lives inside `planTripDeterministic`, which only runs on replan turns (no-active-route + post-delivery). On pure `[route-executor]` turns the latch never updates. For game 086fa2ce s1, planTripDeterministic ran on a handful of T68–T79 turns (build turns + T75 + T79); the other 15+ end-state turns never touched the lock.

Move the latch to `ContextBuilder` — same place where `computeGameState` decides `gameState=end`:

```ts
// ContextBuilder.ts, right after computeGameState (~line 192)
const gamePhase = computeGameState({ money, turnNumber }, memoryForPhase);
const shouldLockEndGame = gamePhase === GameState.End ||
  classifyGamePhase(turnNumber, deliveryCount, connectedMajorCities.length) === 'late';
if (!memoryForPhase.endGameLocked && shouldLockEndGame) {
  updateMemory(snapshot.gameId, snapshot.bot.playerId, { endGameLocked: true }).catch(...);
  memoryForPhase.endGameLocked = true; // mutate in-place so downstream callers in this turn see true
}
```

Then **remove the latch from `planTripDeterministic`** (lines 1671-1684) — it's redundant once ContextBuilder owns the source of truth. The downstream consumers (`cheapPrune`, `applyEndStateScoring`, win-completer ranking, reasoning annotation) all read `memory.endGameLocked` and will see the correct value regardless of whether planTripDeterministic runs.

**Effect:** every turn in `gameState=end` (or `phase=late`) has `endGameLocked=true` from the moment ContextBuilder runs. The Layer 1 `endGameTrace.endGameLocked` field now reflects reality.

Add a single ContextBuilder-emitted log line on the transition turn (similar to the existing `[game-state] ENTER End | ...` line in the local end-game logging branch — re-use that if it's already merged):

```
[end-game-lock] ENTER engaged at T<N>: cash=$<X>M, majors=<Y>/7, fullWinCost=$<Z>M
```

## Layer 3 — Align `gamePhase` display with `gameState=end`

**Defect locus.** `src/server/services/ai/context/NetworkContext.ts:259-269` (`computePhase`).

The display field never returns "End Game" — its ceiling is "Victory Imminent" (6+ majors AND $230, or 5+ AND $250). When `gameState=end` has latched at cash > $200M but the bot has only 3–4 majors, `gamePhase` rolls back down to "Mid Game" (3+ majors / $80M branch at line 267).

Fix: when `gameState==='end'`, `gamePhase` should reflect that. Simplest change — pass `gameState` into `computePhase` (or compute display from a single source):

```ts
// NetworkContext.computePhase signature update
static computePhase(snapshot: WorldSnapshot, connectedMajorCities: string[], gameState: GameState): string {
  if (gameState === GameState.End) {
    // Bot has reached end-game state (cash > $200M latched). Refine the display
    // based on how close it actually is to victory.
    if (connectedMajorCities.length >= 7 && snapshot.bot.money >= 250) return 'Victory Imminent';
    if (connectedMajorCities.length >= 6 && snapshot.bot.money >= 230) return 'Victory Imminent';
    return 'End Game';
  }
  // existing thresholds for Initial/Early/Mid/Late
  ...
}
```

Caller passes `gamePhase` from the already-computed `computeGameState` result. No new computation, just thread the value through.

After this, the T65 log line in game 086fa2ce would read `End Game | Cash: 255M` instead of `Mid Game | Cash: 255M`, immediately telling a reader the bot is in end-state regardless of major count.

## Acceptance criteria

- **AC1 (Layer 1: trace populated)** Unit test on `AIStrategyEngine.takeTurn`: fixture with `context.gameState=GameState.End`, `cash=$210M`, `connectedMajorCities.length=4`, `unconnectedMajorCities=[Holland($20M), Paris($15M), Wien($25M), London($30M)]`. Assert the resulting turn-log entry has:
  - `composition.endGame.inEndGame === true`
  - `composition.endGame.cashGapM === 40`
  - `composition.endGame.majorsGap === 3`
  - `composition.endGame.cheapestConnectors` lists Paris/Holland/Wien (sorted ascending by cost), totaling $60M
  - `composition.endGame.fullWinCostM === 100`

- **AC2 (Layer 1: skip reason)** Unit test where `findFinalVictoryRoute` returns the `no_route_covers_gap` skip. Assert `composition.endGame.victoryRouteProjection === { outcome: 'skip', reason: 'no_route_covers_gap' }`.

- **AC3 (Layer 1: fire path)** Unit test where `findFinalVictoryRoute` fires and the override applies. Assert `victoryRouteProjection.outcome === 'fire'` with all route fields populated and `appliedOverride === true`. (Also covered by JIRA-261 idempotency suppression path: `appliedOverride === false` when routesMatch suppresses.)

- **AC4 (Layer 2: latch fires on execution-only turn)** Integration test: bot in `gameState=end` with no replan triggered (route-executor turn). Assert `memory.endGameLocked === true` after `ContextBuilder.build` returns, regardless of whether `planTripDeterministic` is called this turn.

- **AC5 (Layer 2: latch sticky)** Same fixture as AC4 but starting with `memory.endGameLocked === true` and cash dipped to $150M (e.g., post-build dip). Assert `endGameLocked` remains `true` (sticky one-way).

- **AC6 (Layer 3: display reflects end-game)** Unit test on `NetworkContext.computePhase` with `gameState=End`, 4 majors, cash $255M. Assert returns `'End Game'`. Same fixture with 7 majors + $250M → `'Victory Imminent'`. Same fixture with `gameState=Mid` → existing thresholds apply (Mid Game).

- **AC7 (replay)** Replay s1 game 086fa2ce T60–T79. For each turn:
  - T60: `endGame` undefined or `inEndGame=false`.
  - T61–T79: `endGame.inEndGame === true`, `endGameLocked === true` (after Layer 2), `cashGapM` and `majorsGap` populated correctly.
  - T75: `victoryRouteProjection.outcome === 'fire'` with `appliedOverride === false` (routesMatch suppresses; existing JIRA-261 behavior).
  - T79: `endGame.activePlanProjection.willClinch === true` BEFORE the delivery completes.

## Files touched

- `src/server/services/ai/victoryRules.ts` — return-shape change for `findFinalVictoryRoute`; update callers.
- `src/server/services/ai/ContextBuilder.ts` — add end-game-lock latch alongside `computeGameState`; thread `gamePhase` into the returned `GameContext`.
- `src/server/services/ai/context/NetworkContext.ts` — `computePhase` takes `gameState` and returns `'End Game'` when latched.
- `src/server/services/ai/AIStrategyEngine.ts` — construct `EndGameTrace` per turn; thread into turn-log composition.
- `src/server/services/ai/DeterministicTripPlanner.ts` — remove the now-redundant latch block (lines 1671-1684); downstream consumers unchanged.
- `src/server/services/ai/GameLogger.ts` — add `composition.endGame?: EndGameTrace` to `GameTurnLogEntry`.
- `src/shared/types/GameTypes.ts` — declare `EndGameTrace` interface (or co-locate with victoryRules).
- Tests: `src/server/__tests__/ai/AIStrategyEngine.endGameTrace.test.ts` (new), `src/server/__tests__/ai/ContextBuilder.endGameLock.test.ts` (new), and updates to existing `victoryRules.test.ts` for the return-shape change.

## Diagnostic-value validation

After the fix, the reader of any future game NDJSON can:

```bash
jq -c 'select(.gameState=="end") | {turn, cash, majors: (.connectedMajorCities|length), endGame: .composition.endGame}' \
  logs/game-<id>.ndjson
```

and see one structured object per turn:

```
{"turn":61,"cash":222,"majors":4,"endGame":{"inEndGame":true,"endGameLocked":true,"cashGapM":28,"majorsGap":3,"cheapestConnectors":[...],"fullWinCostM":88,"victoryRouteProjection":{"outcome":"skip","reason":"no_route_covers_gap"},"activePlanProjection":{"willClinch":false,...}}}
```

The operator can then immediately spot:
- Turns where the bot is in end-game but `victoryRouteProjection.outcome` is consistently `skip` — diagnostic for "why isn't `findFinalVictoryRoute` finding a route?"
- Turns where `activePlanProjection.willClinch=false` — diagnostic for "the bot's current plan won't win; why hasn't it replanned?"
- Turns where `endGameLocked=true` but the `[deterministic-top-1]` reasoning shows velocity-only ranking — diagnostic for "is the win-completer carve-out actually firing?"

## Not in scope

- Changes to the actual scoring/ranking math inside `applyEndStateScoring` or the win-completer comparator. The current ticket is visibility + latch placement. If post-fix logs show the carve-out is firing but picking suboptimal plans, that's a follow-up ticket with concrete evidence.
- Surfacing `composition.endGame` into the debug UI overlay. Future work; this ticket adds the data only.
- Backfill of past games. Going-forward only.
- The `findFinalVictoryRoute` double-counting hypothesis from the previous draft of this ticket. The diagnostic test for that lives in this conversation but the bug exists in math that's hidden by the visibility gap; with Layer 1 in place, future investigation can confirm or refute on real game data. Not in scope for this ticket.

## Cross-references

- JIRA-241 — `gameState` latch in ContextBuilder. The new `endGameLocked` latch lives in the same place after Layer 2.
- JIRA-245 — `findFinalVictoryRoute`. Return shape change (Layer 1) updates the caller contract.
- JIRA-255 — `endGameLocked` was introduced inside `planTripDeterministic`. Layer 2 relocates it; the downstream consumers (`cheapPrune` carve-out, win-completer ranking, reasoning annotation) are unchanged.
- JIRA-261 — `routesMatch` idempotency check. The `appliedOverride` field in `victoryRouteProjection` lets the reader distinguish "fired but suppressed" from "fired and applied", which is exactly the diagnostic the JIRA-261 behavioral doc wished for.
- JIRA-262 — event-card observability gap (parallel `events.ndjson`). The shape this ticket adds is a per-turn structured field on the existing game log; the parallel-file approach from JIRA-262 is unnecessarily heavy for this case.

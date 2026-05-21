# JIRA-3: Enforce Complete Turn Workflow (Move + Pickup/Deliver + Build)

## Motivation

The bot frequently plays **partial turns** — executing only one or two phases when the game rules allow all of them in a single turn. Per the EuroRails rules:

> On a player's turn, they must:
> 1. **FIRST**, operate their train (move, load, unload, pay fees, collect payoffs)
> 2. **THEN**, spend up to ECU 20M to build track OR upgrade their train

This means a bot should attempt **every applicable phase** each turn:
1. Move toward destination
2. Pick up loads at cities passed through (or arrived at)
3. Deliver loads at demand cities passed through (or arrived at)
4. Build track (up to 20M budget)

### Current Behavior

The bot does NOT systematically attempt all phases. Instead, it relies on **three ad-hoc enhancement methods** in PlanExecutor that opportunistically chain actions:

| Enhancement | What it does | What it misses |
|---|---|---|
| `chainArrivalAction` | Move lands at target city -> chain pickup/deliver | Only fires when the exact target city is the move destination. Ignores intermediate cities. |
| `chainMoveAfterAct` | After pickup/deliver -> chain move toward next stop | Only fires for route-based flows. Never chains a further pickup/deliver at the move destination. |
| `appendBuildStep` | After non-build action -> append build | Works reasonably well, but uses stale snapshot budget (doesn't account for money from deliveries in the same turn). |

### Specific Gaps

1. **Primary phase locks out other phases.** PlanExecutor picks ONE primary phase (`build`, `travel`, or `act`), then chains are best-effort. If the primary phase is `build`, no move/deliver/pickup is attempted. If it's `travel`, no build is attempted when the move doesn't arrive at the target city.

2. **Intermediate city opportunities missed.** When a move path passes through a supply city, no pickup is attempted. When it passes through a delivery city while carrying a matching load, no delivery is attempted. The `canDeliver` and `canPickup` context fields only reflect the bot's **current position**, not cities along a planned path.

3. **Heuristic fallback returns single actions.** `ActionResolver.heuristicFallback()` evaluates a priority chain (deliver > pickup > move > build > pass) but returns the **first match** — never a MultiAction. If it returns a move, no build is appended. If it returns a pickup, no move follows.

4. **No post-delivery build.** After delivering a load (earning money), the bot could build track with its newly increased budget. But `appendBuildStep` uses the original `snapshot` which has the pre-delivery money amount. Even with the enhancement firing, the budget calculation is wrong.

5. **LLM per-turn path has no enforcement.** When the LLM is consulted for per-turn decisions (`brain.decideAction`), it may suggest a single action. No component adds missing phases after the LLM's choice (except GuardrailEnforcer for pickup/deliver).

### Impact

A bot that uses only 1-2 of its 4 available phases per turn plays at ~25-50% efficiency compared to a human who routinely moves, picks up, delivers, and builds in a single turn. Over 20 turns, this means 20-40 wasted action slots.

## Proposed Solution: TurnComposer

Introduce a `TurnComposer` — a post-decision layer that takes a primary TurnPlan and systematically attempts to fill in missing phases. It replaces the three ad-hoc enhancement methods in PlanExecutor.

### Design Principles

1. **Respect the primary decision.** TurnComposer does not override the primary action — it only appends additional phases that the primary action left on the table.
2. **Follow game rule ordering.** Operate train first (move, pickup, deliver), then build/upgrade. Within operations, pickups and deliveries can happen at any point during movement.
3. **Simulate state between phases.** Each appended phase uses an updated snapshot reflecting prior phases' effects (position, money, loads).
4. **Fail-safe.** If any appended phase fails to resolve, skip it — don't lose the primary action.

### Phase Composition Logic

```
TurnComposer.compose(primaryPlan, snapshot, context) -> TurnPlan

Given the primary plan:

1. Start with steps = [primaryPlan]
2. Simulate state after primary plan -> updatedSnapshot

Phase A: Operational (move + pickup/deliver)
  - If primary is MOVE:
      a. Check cities along the move path for pickup/deliver opportunities
      b. At final destination, check for pickup/deliver
  - If primary is PICKUP or DELIVER:
      a. Check for additional pickup/deliver at current city
      b. Try to MOVE toward next route stop or best demand city
      c. At move destination, check for pickup/deliver

Phase B: Build/Upgrade (mutually exclusive, only one per turn)
  - If no BUILD or UPGRADE in steps so far:
      a. Compute remaining budget from updatedSnapshot.bot.money
      b. If canBuild and budget > 0, resolve BUILD toward best target
      c. Append BUILD step if successful

Return MultiAction(steps) if steps.length > 1, else primary plan unchanged
```

### Key Difference from Current System

| Aspect | Current (PlanExecutor enhancements) | Proposed (TurnComposer) |
|---|---|---|
| Trigger | Each enhancement checks independently | Single orchestrator runs all phases |
| Ordering | Enhancements run in fixed order regardless of primary | Phases ordered by game rules |
| State tracking | All use original snapshot | Cumulative state simulation between phases |
| Intermediate cities | Ignored | Move path scanned for opportunities |
| Coverage | Only fires for specific primary types | Fires for ALL primary types |
| Budget accuracy | Uses pre-turn money | Uses post-delivery money |

## Files to Change

### 1. New File: `src/server/services/ai/TurnComposer.ts`

Core implementation:

```typescript
export class TurnComposer {
  /**
   * Given a primary TurnPlan, attempt to fill in missing turn phases.
   * Returns a MultiAction combining all applicable phases, or the
   * primary plan unchanged if no additional phases are possible.
   */
  static async compose(
    primaryPlan: TurnPlan,
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<TurnPlan>;

  /**
   * Scan a move path for pickup/deliver opportunities at intermediate cities.
   * Returns additional TurnPlan steps for cities along the path.
   */
  private static async scanPathOpportunities(
    path: { row: number; col: number }[],
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<TurnPlan[]>;

  /**
   * Attempt to append a build step using the current (post-operation) budget.
   * Finds the best build target from the active route or demand cards.
   */
  private static async tryAppendBuild(
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute: StrategicRoute | null,
  ): Promise<TurnPlan | null>;
}
```

### 2. Modify: `src/server/services/ai/PlanExecutor.ts`

| Change | Detail |
|---|---|
| Delete `chainArrivalAction` | Replaced by TurnComposer Phase A |
| Delete `chainMoveAfterAct` | Replaced by TurnComposer Phase A |
| Delete `appendBuildStep` | Replaced by TurnComposer Phase B |
| Delete `findNextBuildTarget` | Moved to TurnComposer |
| Delete `findDemandBuildTarget` | Moved to TurnComposer |
| Simplify `execute()` | Remove enhancement calls (lines 84-91). Return the raw primary plan. |

After this change, `PlanExecutor.execute()` becomes a pure phase-selection state machine with no multi-action logic.

### 3. Modify: `src/server/services/ai/AIStrategyEngine.ts`

| Line(s) | Change |
|---|---|
| Import | Add `import { TurnComposer } from './TurnComposer';` |
| After decision gate (line ~203) | Insert `decision.plan = await TurnComposer.compose(decision.plan, snapshot, context);` |

This is the single integration point. TurnComposer runs between the decision gate and the guardrail enforcer, so:
- Route-executor decisions get composed
- LLM decisions get composed
- Heuristic fallback decisions get composed
- GuardrailEnforcer still has final veto power after composition

### 4. Modify: `src/server/services/ai/ContextBuilder.ts`

| Change | Detail |
|---|---|
| Add `computePathOpportunities` method | Given a move path, compute which cities along it have pickup/deliver opportunities. Returns the opportunities indexed by path position. |

This is needed by TurnComposer to scan intermediate cities during a move.

### 5. Modify: `src/server/services/ai/ActionResolver.ts`

| Change | Detail |
|---|---|
| Update `applyPlanToState` visibility | Change from `private static` to `static` — TurnComposer needs it for cumulative state simulation |
| Update `cloneSnapshot` visibility | Change from `private static` to `static` — TurnComposer needs it |

No logic changes — just visibility for reuse.

### 6. Tests

#### New: `src/server/__tests__/ai/TurnComposer.test.ts`

Test cases:
- Primary MOVE arrives at delivery city -> MOVE + DELIVER composed
- Primary MOVE arrives at supply city -> MOVE + PICKUP composed
- Primary DELIVER with budget remaining -> DELIVER + BUILD composed
- Primary DELIVER earns money -> BUILD uses post-delivery budget
- Primary PICKUP -> PICKUP + MOVE toward delivery + BUILD composed
- Primary BUILD (initial build phase) -> no operational phases appended
- Primary MOVE through intermediate supply city -> MOVE + PICKUP at intermediate
- Primary PASS -> attempt MOVE or BUILD fallback
- Failed append phases are silently skipped (don't lose primary)
- DISCARD_HAND is never composed with other actions (exclusive)
- UPGRADE + BUILD are never composed together (mutually exclusive)

#### Modify: `src/server/__tests__/ai/PlanExecutor.test.ts`

- Delete tests for `chainArrivalAction`, `chainMoveAfterAct`, `appendBuildStep`
- Update remaining tests to expect raw (non-composed) plans from PlanExecutor
- Keep phase-selection tests (build/travel/act transitions)

## Implementation Order

1. **ActionResolver visibility** — Make `applyPlanToState` and `cloneSnapshot` public (no logic change, all existing tests still pass)
2. **TurnComposer** — New file with compose logic + tests
3. **AIStrategyEngine integration** — Insert `TurnComposer.compose()` call after decision gate
4. **PlanExecutor cleanup** — Remove enhancement methods, simplify execute()
5. **PlanExecutor tests** — Update to remove enhancement tests
6. **ContextBuilder** — Add `computePathOpportunities` if intermediate city scanning is implemented
7. **Build + test** — `npm run build && npm test`

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Bot has no money after move fees | Skip build phase (budget = 0) |
| Bot delivers, earns 30M, then builds | Build uses 30M + original money (post-delivery snapshot) |
| Move path passes through 3 supply cities | Pick up at the first one with matching demand (capacity permitting) |
| Bot already at capacity (2/2 loads) | Skip pickup phase |
| DISCARD_HAND as primary | Return unchanged — exclusive action, no composition |
| UPGRADE as primary | Skip build phase (mutually exclusive per game rules) |
| Route complete, no build target | Return primary plan unchanged |
| Primary plan is PassTurn | Try heuristic: move toward demand, build toward demand |

## Verification

1. `npm run build` — compiles clean
2. `npm test` — all tests pass (including new TurnComposer tests)
3. Manual observation: Bot should now routinely produce MultiAction turns like:
   - `MOVE(Roma) + DELIVER(Wine@Roma) + BUILD(toward München)`
   - `PICKUP(Coal@Essen) + MOVE(toward Paris) + BUILD(toward Paris)`
   - `DELIVER(Oil@London, +25M) + BUILD(toward Edinburgh, $20M budget)`
4. Turn logs should show 2-4 steps per turn in most mid-game turns, vs 1-2 currently

## Non-Goals (Explicitly Out of Scope)

- **Route planning changes.** This JIRA does not change how routes are planned — only how a single turn's actions are composed after the strategic decision is made.
- **LLM prompt changes.** The LLM doesn't need to know about TurnComposer — it still suggests single intents and the composer fills in the rest.
- **Budget reserves.** Per user veto (MEMORY.md), no cash reserve enforcement is added. The build phase uses the full available budget.

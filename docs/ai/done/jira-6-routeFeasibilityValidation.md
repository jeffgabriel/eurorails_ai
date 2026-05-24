# JIRA-6: Validate LLM Route Feasibility Before Committing

## Motivation

The LLM plans multi-stop strategic routes via `brain.planRoute()`, but the only validation is `route.stops.length > 0`. There is no check for whether the planned route is physically achievable — the bot blindly commits to routes it cannot afford, cannot reach, or has no supply access for.

### Observed Failure (game d861789d, turns 7-10)

The LLM planned a route including oranges delivery to Aberdeen as a second stop. This route was infeasible for three reasons:

1. **No pathway to pickup**: The bot had no track near Valencia (oranges supply city) and no budget to build there. The oranges pickup required ~20M in new track, but the bot had ~7M after its first delivery.
2. **No pathway to delivery**: Aberdeen is in northern Scotland — the bot's track network was in central Europe (Wien/Paris corridor). Reaching Aberdeen required ~35M+ in new track across the English Channel.
3. **Total route cost exceeded cash**: The combined track cost for both stops far exceeded the bot's available money. The bot went bankrupt trying to execute the second stop.

The LLM was never told "this route is infeasible" — it passed the only validation gate (`stops.length > 0`) and was committed as the active route. PlanExecutor then spent 3 turns building toward an unreachable city until the bot ran out of money.

### Where validation is missing

```
LLMStrategyBrain.planRoute()
  └── ResponseParser.parseStrategicRoute(response.text)
  └── if (route.stops.length === 0) → retry   ← ONLY VALIDATION
  └── return route                              ← committed as activeRoute

AIStrategyEngine.takeTurn()
  └── brain.planRoute(snapshot, context)
  └── activeRoute = routeResult.route          ← NO FEASIBILITY CHECK
  └── PlanExecutor.execute(activeRoute, ...)   ← blindly executes
```

Compare with `decideAction()`, which validates every LLM response through `ActionResolver.resolve()` — if resolution fails, the error is fed back to the LLM for retry. `planRoute()` has no equivalent resolution/validation step.

## Proposed Fix

Add a `RouteValidator` that checks each stop in the LLM's proposed route against the current game state. If a stop is infeasible, either prune it or reject the route with an error message fed back to the LLM for retry.

### Feasibility checks per stop

| Check | What it validates | Data source |
|-------|-------------------|-------------|
| **Supply reachability** | For `pickup` stops: Can the bot reach the supply city? Is it on-network, or within affordable build distance? | `DemandContext.isSupplyOnNetwork`, `estimatedTrackCostToSupply` |
| **Delivery reachability** | For `deliver` stops: Can the bot reach the delivery city? | `DemandContext.isDeliveryOnNetwork`, `estimatedTrackCostToDelivery` |
| **Load availability** | For `pickup` stops: Is the load type actually available (not all chips carried by other players)? | `DemandContext.isLoadAvailable` |
| **Demand card exists** | For `deliver` stops: Does the bot actually hold a demand card matching this load+city? | `context.demands[]` |
| **Cumulative budget** | Running total of estimated track costs across all stops. If cumulative cost exceeds `bot.money + expected payouts from earlier stops`, the stop is unaffordable. | `estimatedTrackCostToSupply`, `estimatedTrackCostToDelivery`, `bot.money`, stop payouts |
| **City name valid** | Both pickup and deliver city names resolve to actual map positions. | `ActionResolver.findCityMilepost()` |

### Validation outcomes

| Result | Action |
|--------|--------|
| All stops feasible | Accept route as-is |
| Some stops infeasible | Prune infeasible stops. If remaining stops are valid (≥1 stop), use pruned route. |
| All stops infeasible | Reject route. Feed error back to LLM for retry (same retry loop as `decideAction`). |
| Route feasible but marginal (budget within 5M of total cost) | Accept but log a warning for observability. |

### Where validation runs

Validation should run in `LLMStrategyBrain.planRoute()` after `parseStrategicRoute()` but before returning the route. This mirrors how `decideAction()` runs `ActionResolver.resolve()` after parsing:

```
planRoute():
  parse response → parseStrategicRoute()
  validate route → RouteValidator.validate(route, context, snapshot)  ← NEW
  if invalid → lastError = validation message → retry loop
  return validated route
```

## Files to Change

### 1. New: `src/server/services/ai/RouteValidator.ts`

| Method | Purpose |
|--------|---------|
| `static validate(route, context, snapshot): RouteValidationResult` | Run all feasibility checks on each stop. Returns `{ valid: boolean; prunedRoute?: StrategicRoute; errors: string[] }` |
| `private static checkPickupFeasibility(stop, context, snapshot)` | Validate supply reachability, load availability, city exists |
| `private static checkDeliverFeasibility(stop, context, snapshot)` | Validate delivery reachability, demand card held, city exists |
| `private static checkCumulativeBudget(stops, context, snapshot)` | Running budget check accounting for expected payouts from earlier stops |

### 2. `src/server/services/ai/LLMStrategyBrain.ts`

| Line | Change |
|------|--------|
| ~207-215 | After `parseStrategicRoute()`, call `RouteValidator.validate()`. On failure, set `lastError` to validation errors and continue retry loop. On partial failure (some stops pruned), use pruned route. |

### 3. Tests: `src/server/__tests__/ai/RouteValidator.test.ts`

| Test | What it covers |
|------|---------------|
| Route with all stops feasible → accepted | Happy path |
| Route with unreachable supply city → stop pruned | Supply reachability check |
| Route with unreachable delivery city → stop pruned | Delivery reachability check |
| Route where load chips all carried → stop pruned | Load availability check |
| Route with no matching demand card → stop pruned | Demand card validation |
| Route where cumulative cost > money → later stops pruned | Budget check |
| All stops pruned → route rejected | Full rejection → retry |
| Pruned route retains valid stops in order | Partial pruning |
| City name that doesn't resolve → stop pruned | Invalid city name |
| Budget check accounts for earlier stop payouts | Payout-adjusted budget |

### 4. Tests: `src/server/__tests__/ai/LLMStrategyBrain.test.ts`

| Test | What it covers |
|------|---------------|
| planRoute retries when RouteValidator rejects | Integration with retry loop |
| planRoute uses pruned route when partial failure | Pruned route acceptance |

## Implementation Detail: Cumulative Budget Check

The budget check is the most nuanced. It must account for the fact that stops are executed in order, and earlier deliveries earn money that funds later builds:

```typescript
let runningCash = snapshot.bot.money;
for (const stop of route.stops) {
  if (stop.action === 'pickup') {
    const demand = findMatchingDemand(stop, context);
    const trackCost = demand?.estimatedTrackCostToSupply ?? 0;
    if (trackCost > runningCash) {
      // Can't afford to reach this pickup
      markInfeasible(stop, `Need ~${trackCost}M track to reach ${stop.city}, only have ${runningCash}M`);
    }
    runningCash -= trackCost;
  } else if (stop.action === 'deliver') {
    const demand = findMatchingDemand(stop, context);
    const trackCost = demand?.estimatedTrackCostToDelivery ?? 0;
    if (trackCost > runningCash) {
      markInfeasible(stop, `Need ~${trackCost}M track to reach ${stop.city}, only have ${runningCash}M`);
    }
    runningCash -= trackCost;
    runningCash += stop.payment ?? 0; // delivery income funds later stops
  }
}
```

Note: `estimatedTrackCostToSupply` and `estimatedTrackCostToDelivery` are already computed by `ContextBuilder.computeDemandContext()` — no new pathfinding needed.

## Example: Before vs After

### Before (current behavior)

```
Turn 7: LLM plans route: pickup(Flowers@Holland) → deliver(Flowers@Wien) → pickup(Oranges@Valencia) → deliver(Oranges@Aberdeen)
        Validation: stops.length=4 > 0 ✓ → route accepted
Turn 7: PlanExecutor executes stop 1: pickup Flowers ✓
Turn 8: PlanExecutor executes stop 2: deliver Flowers at Wien ✓ (+18M)
Turn 9: PlanExecutor executes stop 3: build toward Valencia (spend 18M on track)
Turn 10: PlanExecutor: 0M remaining, can't build → PassTurn → bankruptcy spiral
```

### After (with RouteValidator)

```
Turn 7: LLM plans route: pickup(Flowers@Holland) → deliver(Flowers@Wien) → pickup(Oranges@Valencia) → deliver(Oranges@Aberdeen)
        RouteValidator:
          Stop 1 pickup(Flowers@Holland): supply ON NETWORK ✓, load available ✓ → feasible
          Stop 2 deliver(Flowers@Wien): delivery ON NETWORK ✓, demand card held ✓ → feasible
          Stop 3 pickup(Oranges@Valencia): supply NOT on network, ~20M track needed, running cash after stop 2 = ~25M ✓ → feasible
          Stop 4 deliver(Oranges@Aberdeen): delivery NOT on network, ~35M track needed, running cash after stop 3 = ~5M ✗ → INFEASIBLE
        Pruned route: stops 1-3 only (or reject stop 3+4 pair since deliver is pruned)
        LLM retry with error: "Stop 4 infeasible: need ~35M track to reach Aberdeen, only ~5M available after earlier stops"
```

## Non-Goals

- **No changes to PlanExecutor or TurnComposer.** This is a pre-commitment validation gate only.
- **No new pathfinding.** Uses existing `estimatedTrackCost` values from `DemandContext`.
- **No LLM prompt changes.** The validation error messages are fed back via the existing retry mechanism — no new prompt format needed.
- **No strategic judgment.** The validator checks physical/financial feasibility only. It does NOT evaluate whether a route is strategically optimal — that's the LLM's job (and JIRA-5's enriched context will help).

## Relationship to Other Tickets

| Ticket | Relationship |
|--------|-------------|
| **JIRA-5** (Route Planning Context) | Complementary. JIRA-5 gives the LLM better information to plan good routes. JIRA-6 catches the LLM when it plans bad ones anyway. Both are needed — better input reduces but doesn't eliminate bad outputs. |
| **JIRA-3** (TurnComposer) | Independent. TurnComposer enriches turn execution. RouteValidator gates route commitment. |
| **JIRA-1** (Initial Build) | Independent. When JIRA-1 wires `planRoute()` into initial build, RouteValidator will automatically validate those routes too — no extra work needed. |

## Verification

1. `npm run build` — compiles clean
2. `npm test` — all tests pass (new RouteValidator tests + updated LLMStrategyBrain tests)
3. Manual: Start game with LLM bot, observe logs for:
   - `[RouteValidator]` log lines showing per-stop feasibility checks
   - Infeasible stops logged with reason
   - Pruned or rejected routes trigger LLM retry
4. Regression: Bot should no longer commit to routes with unreachable cities or unaffordable track costs

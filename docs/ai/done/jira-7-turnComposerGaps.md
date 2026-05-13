# JIRA-7: Fix Remaining Turn Composition Gaps

## Motivation

JIRA-3 introduced TurnComposer to replace three ad-hoc enhancement methods. It solved the biggest problem — the bot now attempts all turn phases (move, pickup/deliver, build) instead of just one. But testing reveals the bot still plays **partial turns** in specific scenarios.

Three bugs were found and fixed during investigation, but a pattern of remaining gaps exists. The bot leaves actions on the table in predictable situations.

## Bugs Already Fixed (Context)

These were found during the Torino/Nantes investigation and are already committed:

1. **Only major cities scanned during movement.** `splitMoveForOpportunities` used a major-city-only lookup. A bot moving through a medium city like Torino wouldn't detect a pickup there. Fixed — now scans all cities.

2. **No continuation move after mid-path pickup.** Bot moves London→Paris→Berlin, picks up Wine at Paris (mid-path), delivers Wine at Berlin (end). But if it picks up at Berlin (the destination), it stops — no continuation move toward the next stop. Fixed — A2 now triggers when the last step is PICKUP or DELIVER regardless of prior moves.

3. **Continuation move targeted the city the bot just left.** After picking up Cars at Torino, `findMoveTarget` returned Torino (the current route stop) instead of Nantes (the delivery city). Fixed — now skips pickup stops where the bot already has the load.

4. **No movement cap on continuation moves.** A bot that moved 4 mileposts then chained a continuation could move 9 more — exceeding its 9-milepost limit. Fixed — continuation moves are now capped at `speed - movementUsed`.

## Remaining Gaps

### Gap 1: findMoveTarget doesn't skip completed deliver stops

**What happens:** Bot delivers Wine at Berlin during mid-movement composition. `findMoveTarget` returns Berlin (the deliver stop just completed) instead of advancing to the next stop.

**Why:** `findMoveTarget` only skips pickup stops where the bot already has the load. It has no equivalent check for deliver stops where the bot just completed a delivery.

**Example:** Route is `pickup Wine at Bordeaux → deliver Wine at Berlin → pickup Oil at Baku`. Bot delivers Wine at Berlin during A1 mid-movement scan. A2 asks "where should I continue moving?" and gets Berlin — the city it's already at.

**Expected:** After delivering Wine at Berlin, continue toward Baku (the next stop).

### Gap 2: Heuristic fallback returns single actions — no composition

**What happens:** When neither the route executor nor the LLM is available, `heuristicFallback` returns a single action (the first match in its priority chain). TurnComposer then enriches it, but the initial action quality is poor.

**Why:** Heuristic evaluates deliver > pickup > move > build > discard > pass. It returns the first match. If the best action is DELIVER, it returns just the deliver — no move toward the next pickup. TurnComposer can append a build, but operational enrichment depends on the primary being a MOVE (A1) or the primary being a PICKUP/DELIVER at the current location (A2).

**Example:** Bot is at Paris carrying Wine with a demand for Wine at Berlin. Heuristic says "deliver Wine" — but the bot isn't at Berlin. It should say "move toward Berlin" (which TurnComposer can then enrich with mid-path opportunities and a build). Instead it returns a DELIVER that fails validation.

**Expected:** Heuristic should produce actionable plans that TurnComposer can meaningfully enrich.

### Gap 3: Build appending uses stale budget after deliveries

**What happens:** Bot delivers a load during Phase A (earning money), then Phase B checks the build budget. But the simulated snapshot's money was updated by `applyPlanToState` for the delivery — this part works. However, `tryAppendBuild` checks `Math.min(20 - context.turnBuildCost, snapshot.bot.money)`. If the delivery payout hasn't been applied to the simulated snapshot's money correctly (e.g., `applyPlanToState` doesn't model delivery payouts), the budget is wrong.

**Example:** Bot starts with 5M, delivers Cheese at Berlin for 12M during Phase A. Should have 17M for building. If sim doesn't reflect the payout, bot thinks it only has 5M.

**Expected:** Build budget should reflect all money earned during the same turn.

### Gap 4: Route sync gap — composition doesn't advance the route

**What happens:** TurnComposer delivers a load that matches the current route stop. But the route's `currentStopIndex` doesn't advance during composition — it only advances after `AIStrategyEngine` processes the result. Next turn, PlanExecutor sees the same stop and tries to deliver again.

**Why:** TurnComposer operates on a simulated snapshot and doesn't write back to the route state. AIStrategyEngine handles route advancement after execution, but it may not detect that a delivery was completed inside a multi-step composition.

**Example:** Route stop 2 is "deliver Wine at Berlin." TurnComposer's A1 scan finds the delivery opportunity mid-movement and executes it. Next turn, PlanExecutor tries to deliver Wine at Berlin again — but the bot no longer has Wine.

**Expected:** When composition completes a route stop's action, the route should advance so PlanExecutor doesn't retry.

### Gap 5: A3 (prepend MOVE before BUILD) doesn't cap movement

**What happens:** When the primary plan is BUILD and no MOVE exists, A3 prepends a MOVE. But unlike A2, A3 doesn't cap the move at the remaining movement allowance. In practice this is fine because the bot hasn't moved yet (it's the first action), but it's inconsistent and could break if A3 fires after other steps are added.

**Expected:** A3 should use the same movement cap pattern as A2 for safety.

## Acceptance Criteria

1. Bot continues moving toward the correct next stop after delivering mid-movement
2. Heuristic fallback produces plans that TurnComposer can enrich into full turns
3. Build budget reflects delivery earnings from the same turn
4. Route advances when composition completes a stop's action
5. All movement-adding paths respect the speed limit consistently

## Scope

This is a small focused project — behavioral fixes to TurnComposer and its interaction with the route state machine. No new components needed. Tests should verify each gap with a scenario matching the examples above.

# JIRA-93: Speculative Build Bankrupts Bot — Should Replan Instead of Building Blind

## Observed Behavior

Game `f21a8cd5`, Flash bot (Gemini Flash):

The LLM plans a smart 4-stop route on T2 (`pickup Copper@Wroclaw → pickup Bauxite@Budapest → deliver Copper@Hamburg → deliver Bauxite@København`). RouteValidator prunes the Bauxite stops (cumulative budget), leaving a 2-stop route. Bot delivers Copper at Hamburg on T6 — route complete.

**Now the problems compound:**

1. **T6**: Route executor sees "all route stops reachable" for the completed route. Instead of signaling route completion, it calls `findDemandBuildTarget()` and builds **14 segments toward Warszawa** (18M). Speculative build #1.

2. **T7**: LLM replans: `pickup(Ham@Warszawa) → pickup(Copper@Wroclaw) → deliver(Ham@Manchester)`. RouteValidator prunes Ham stops (Manchester delivery too expensive). Left with naked `pickup(Copper@Wroclaw)` — **a pickup with no delivery in the route**. Bot picks up Copper. Route "complete" instantly.

3. **T8**: Route done → `PassTurn`. TurnComposer Phase B calls `findDemandBuildTarget()` → builds **17 segments toward Sarajevo** (20M). Speculative build #2. Cash: 25M → 5M.

4. **T9**: Heuristic fallback builds 3 segments toward Ruhr (5M). Cash: 0M. Bot is bankrupt with two useless spurs.

## Timeline

| Turn | Cash | Action | Detail |
|------|------|--------|--------|
| T2 | 31M | BuildTrack | LLM plans 4-stop route; validator prunes to 2 stops (Copper@Wroclaw → Hamburg) |
| T4 | 31M | MoveTrain | Picks up Copper at Wroclaw |
| T6 | 25M | BuildTrack | Delivers Copper@Hamburg mid-move (A1). Route complete. **Route executor speculatively builds 14 segs toward Warszawa (18M).** |
| T7 | 25M | MoveTrain | LLM replans; validator prunes to naked `pickup(Copper@Wroclaw)`. Picks up Copper. Route instantly done. |
| T8 | **5M** | BuildTrack | Route done → PassTurn → **Phase B builds 17 segs toward Sarajevo (20M)**. |
| T9 | **0M** | BuildTrack | Heuristic fallback builds toward Ruhr (5M). Bankrupt. |

## Root Cause

Two distinct bugs:

### Bug 1: activeRoute goes null when it shouldn't

At T7, the LLM planned `pickup(Ham@Warszawa) → pickup(Copper@Wroclaw) → deliver(Ham@Manchester)`. RouteValidator correctly pruned the Ham stops (too expensive). But this left `pickup(Copper@Wroclaw)` — **a pickup with no corresponding delivery in the route**.

The validator's paired pruning logic (lines 96-122) handles:
- Pickup pruned → prune matching delivery ✓
- Delivery pruned → prune matching pickup ✓

But it does NOT handle:
- **Route with no deliveries after pruning** — the LLM planned Copper as an opportunistic grab ("utilizes the second cargo slot for a future delivery"), not as part of a pickup→deliver pair. When Ham stops were pruned, this orphaned pickup survived and became the entire route.

The pickup-only route was accepted as a valid `activeRoute`. The bot executed it, picked up Copper, route "completed" (all stops done), and activeRoute went to null — triggering the speculative build cascade.

Note: speculative pickups are good strategy (free to carry, smart when near rare resources). The problem isn't the pickup itself — it's that a pickup-only route became the `activeRoute` and went through its full lifecycle (set → execute → complete → null), which poisoned the game state. The pickup should have happened opportunistically via A1 (splitMoveForOpportunities) if the bot passed through Wroclaw, not as the sole purpose of a route.

**Fix**: RouteValidator should reject routes that have no delivery stops after pruning. A route with only pickups has no payout and no destination — it's not a viable route. Return `{ valid: false }` so the bot replans.

### Bug 2: Speculative builds instead of LLM replan

When the route completes (or activeRoute is null) and there are still actions left in the turn, the bot falls through to `findDemandBuildTarget()` — a blind greedy heuristic that picks the cheapest demand city and builds toward it with no strategic plan. This happens in **two places**:

1. **`PlanExecutor.execute()`** (line 138-157): When all route stops are reachable during build phase, it calls `findDemandBuildTarget()` instead of signaling route completion. This caused the T6 Warszawa build.

2. **`TurnComposer.tryAppendBuild()`** (line 733-735): When no active route exists and the bot has budget, it calls `findDemandBuildTarget()` as a "last resort." This caused the T8 Sarajevo build.

Both paths produce speculative builds with no LLM oversight — the bot spends 20M building toward cities it has no plan to reach.

**Fix**: Never build speculatively. When activeRoute is null or completed and there's remaining budget/movement, call the LLM for a new route. `findDemandBuildTarget()` should be removed or restricted to initialBuild only (where the LLM hasn't been called yet). A bot should never build track without a plan.

## Expected Behavior

A human player whose route just completed would:
1. **Look at demand cards and plan next move** — not blindly lay track toward the cheapest demand
2. **Only build track that advances a chosen plan** — never build random spurs "because I can"
The bot should do the same: when the route completes mid-turn, call the LLM for a new plan. Build only in service of that plan.

## Affected Code

| File | Function | Issue |
|------|----------|-------|
| `src/server/services/ai/RouteValidator.ts` | `validate()` | Doesn't prune orphaned pickups (pickup with no delivery in route) |
| `src/server/services/ai/PlanExecutor.ts` | `execute()` line 138-157 | Calls `findDemandBuildTarget()` when route stops are reachable — should signal completion instead |
| `src/server/services/ai/PlanExecutor.ts` | `findDemandBuildTarget()` | Blind greedy heuristic with no affordability check, used for speculative builds |
| `src/server/services/ai/TurnComposer.ts` | `tryAppendBuild()` line 733 | Falls through to `findDemandBuildTarget()` when no active route — should trigger LLM replan |

## Game Evidence

```
Game: f21a8cd5-ed1f-4f54-af6b-b80ddbf3fcda
Bot: 4ad4c400 (Flash / gemini-3-flash-preview)
Key turns: T6 (Warszawa spur, 18M), T8 (Sarajevo spur, 20M) — both speculative builds with no plan
```

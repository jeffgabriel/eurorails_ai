# JIRA-95: Route Executor Broke Death Spiral

## Problem

When a bot goes broke ($0M) mid-route and the remaining route requires track building, the route-executor enters a **permanent death spiral** — it passes turn forever, never abandons the route, never discards hand, and never recovers. The bot is stuck for the rest of the game.

### Root Cause

The route-executor (`PlanExecutor`) has no broke-escape hatch. When it can't afford to build, it outputs `PassTurn` with "Cannot build this turn (budget exhausted). Waiting." — but there is no income source at $0M, so the budget will **never** replenish. The route-executor never falls through to heuristic fallback or LLM re-planning, so the bot never discards hand for new (potentially on-network) demands.

### Example: Game 069de7f0

Flash bot (Gemini 3 Flash) goes broke and enters death spiral:

**Phase 1: Bankruptcy** (T5-T10)
- T5: $10M, route-executor builds 22 segments ($30M!) toward Kaliningrad — overspends, drops to $10M
- T6: $3M, LLM re-plans Iron Kaliningrad→Bremen, builds 5 segments ($7M) toward Bremen
- T7-T9: $3M, route-executor MoveTrain carrying Iron toward Bremen
- T10: $0M after Iron delivery, route-executor **builds 16 segments ($20M) toward Napoli** — a useless spur with no immediate payoff. Bot is now broke.

**Phase 2: Bad Route Choice** (T11-T15)
- T11-T12: $0M, heuristic-fallback correctly discards hand twice
- T13: $0M, LLM plans Coal Wroclaw→Frankfurt — **but Frankfurt is NOT on the network and bot has $0M to build track!** The route validator should have rejected this as infeasible (trackCost=$5M, cash=$0M). Instead it was accepted and the bot committed to an impossible route.
- T14-T15: $0M, route-executor moves toward Wroclaw, picks up Coal — now carrying a load it can never deliver

**Phase 3: Death Spiral** (T16-T24+)
- T16: $0M, route-executor says "Cannot build this turn (budget exhausted). Waiting." → **PassTurn**
- T17-T24: $0M, **9 consecutive PassTurns** — same message every turn
- Bot is carrying Coal, needs $5M track to reach Frankfurt, has $0M, and will never earn money
- Route-executor will pass forever — no escape, no discard, no re-plan

### Related Bugs (separate tickets)

- **JIRA-96**: Route validator ignores cash when accepting routes (T13 accepted trackCost=$5M at $0M)
- **JIRA-97**: Build execution allows spending more than available cash (T10 built $20M at $0M)
- **JIRA-98**: Build execution exceeds $20M/turn limit (T5 built $30M in one turn)

## Fix

### Primary Fix: Broke-escape in route-executor
When the route-executor needs to build but `money < 1` (can't afford even clear terrain):
1. Check if the bot can still complete the route without building (i.e., remaining stops are all reachable on existing track)
2. If not, **abandon the route** — clear the active route plan
3. Fall through to heuristic fallback, which will correctly discard hand (via JIRA-71/94 broke-discard logic)


## Files to Investigate

- `PlanExecutor.ts` — `continuationBuild()`, `resolveBuild()`, and the "budget exhausted" PassTurn logic
- `AIStrategyEngine.ts` — where route-executor results are consumed, add broke-escape before accepting PassTurn
- `TrackBuildingService.ts` — build cost validation, $20M/turn limit enforcement
- `ActionResolver.ts` — `heuristicFallback()` as the target fallback after route abandonment

# JIRA-97: Continuation Build Speculatively Builds Without Valid Route

## Problem

After a delivery, `continuationBuild()` speculatively builds track toward a demand target even when there is no valid LLM-planned route. The bot spends all its delivery income on a useless spur, causing bankruptcy.

### Example: Game 069de7f0, T10

Flash bot at T10 executing Iron Kaliningrad→Bremen route:
- Route-executor moves, delivers Iron at Bremen, collects $17M payout
- LLM re-evaluation triggered (post-delivery, route completed) — **all 3 attempts fail** (tries Steel→Beograd, infeasible at $22M track cost)
- No valid route exists after delivery
- `continuationBuild()` fires anyway — builds 16 segments ($20M) toward **Napoli** (Tobacco demand, not part of any route)
- Bot ends turn at $0M — all delivery income wasted on speculative track

The composition data confirms the disconnect:
- `build: {target: None, cost: 0}` — the turn plan had no build
- Yet the turn result: `action: BuildTrack, cost: 20, segmentsBuilt: 16, buildTargetCity: Napoli`

### Root Cause

`continuationBuild()` in `PlanExecutor` runs after the main turn actions (move/deliver). It uses `findDemandBuildTarget()` to pick the "cheapest actionable demand" and builds toward it — regardless of whether:
1. An LLM-planned route exists for that demand
2. The LLM re-evaluation just failed (meaning no valid route was found)
3. The speculative build makes strategic sense

The continuation build should only build toward targets that are part of an active, validated route — not speculatively pick demands and build toward them.

## Fix

`continuationBuild()` should only fire when there is an active validated route with remaining build targets. If the LLM re-evaluation failed and no route exists, continuation build should be skipped entirely.

Alternatively, continuation build should be gated on: "does the bot have an active route plan, and does that route require building toward a specific target?"

## Files to Investigate

- `PlanExecutor.ts` — `continuationBuild()` (line ~444) and `findDemandBuildTarget()` (line ~383)
- `AIStrategyEngine.ts` — where continuation build is triggered after delivery, whether route state is checked

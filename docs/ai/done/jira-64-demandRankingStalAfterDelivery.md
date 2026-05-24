# JIRA-64: Stale context.demands After Delivery Affects Ranking, Stuck Detection, and Route Validation

## Bug Description

After a mid-turn delivery replaces a demand card with a new draw, `context.demands` is not refreshed. This causes the entire post-execution pipeline to operate on stale data — not just the debug overlay, but also hand quality scoring, stuck detection baselines, route orphan checks, and the NDJSON game log.

JIRA-56 fixed the identical problem for `DiscardHand` but the same refresh was never added for deliveries.

## Evidence

### Game `be09cd45`, Haiku, T29:
- Bot delivered Wine to Praha and drew a new Copper→Manchester (30M) card
- T29 demand ranking shows only Copper→Cardiff (from the pre-turn hand)
- Copper→Manchester doesn't appear until T30's ranking
- User reported: "demand ranking in debug overlay is out of sync with cards tab"

## Downstream Impact of Stale Demands

The stale `context.demands` after delivery affects every consumer in the post-execution pipeline:

1. **Demand ranking** (lines 453-479) — ranking in debug overlay and NDJSON game log doesn't include the newly drawn card, making analysis misleading
2. **Hand quality score** (`computeHandQuality` at line 482) — scored from stale demands, so the `handQuality.score` and `staleCards` count in the audit/game log are wrong. Since hand quality feeds into stuck detection and discard decisions on the *next* turn, this can cascade
3. **Route invalidation check** (JIRA-61, lines 436-441) — checks if active route stops match `context.demands`. The new card isn't present, so orphaned-stop detection could false-positive (invalidating a route that now has a matching demand) or miss (not detecting a newly orphaned stop)
4. **`bestDemandTurns` metric** (lines 483-485) — used for audit logging, computed from stale data

## Root Cause

In `AIStrategyEngine.takeTurn()`, the pipeline is:
1. **Stage 2:** `ContextBuilder.build()` computes `context.demands` from the current hand
2. **Stage 5:** `TurnExecutor.executePlan()` executes delivery (draws new card via `PlayerService.deliverLoadForUser()`)
3. **Post-execution:** All downstream computations use `context.demands` — still the PRE-delivery snapshot

There is a post-delivery ranking emit in `TurnExecutor.handleDeliverLoad()` (lines 678-708), but it uses a simplified `score = payment` instead of the full `scoreDemand()` calculation, and doesn't update the `context.demands` used by AIStrategyEngine.

JIRA-56 already established the pattern: after `DiscardHand`, `context.demands` is refreshed via `ContextBuilder.rebuildDemands()` (lines 430-433). The same refresh is missing after deliveries.

## Fix

Two parts:

### Part 1: Refresh context.demands after delivery

After execution, if any delivery occurred (`hadDelivery` is already computed at line 361), re-capture the snapshot and rebuild `context.demands` before computing the final `demandRanking`, hand quality, and route validation. Mirror the JIRA-56 pattern:

```typescript
if (hadDelivery) {
  const freshSnapshot = await capture(gameId, botPlayerId);
  context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
}
```

Place this alongside the existing JIRA-56 refresh (lines 430-433), before the demand ranking computation at line 453.

### Part 2: Post-delivery LLM re-evaluation

Currently the LLM is called once at the start of the turn (Stage 3). After a mid-turn delivery draws a new demand card, the bot does NOT re-consult the LLM — the new card is only evaluated on the next turn. This means:

- If the new card is a high-value nearby demand, the bot wastes its post-delivery build phase building toward the old route's target instead of pivoting
- If the remaining route stops are now suboptimal compared to the new card, the bot blindly follows the stale plan
- The bot can't make an informed build decision without knowing whether the new card changes the strategy

**After each delivery**, call the LLM with the refreshed `context.demands` and the remaining route stops, asking: "Given this new demand card, is the current plan still valid or should it be amended?" The LLM should be able to:

1. **Continue** — remaining route stops are still the best plan
2. **Amend** — insert/replace stops to incorporate the new demand (e.g., pick up a nearby load on the way)
3. **Abandon** — the new card is so much better that the current route should be dropped entirely

This is especially important for the post-delivery build phase — without re-evaluation, the bot may spend up to 20M building track toward a destination that's no longer optimal.

## Affected Files

- `src/server/services/ai/AIStrategyEngine.ts` — add post-delivery demand refresh (mirror lines 430-433), add post-delivery LLM re-evaluation call
- `src/server/services/ai/LLMStrategyBrain.ts` — may need a lightweight "re-evaluate route" prompt variant (smaller than full `planRoute()`)
- `src/server/services/ai/PlanExecutor.ts` — accept amended route from post-delivery re-evaluation

## Impact

Not cosmetic — stale demands propagate into stuck detection, discard triggers, and route validation on subsequent turns. The missing LLM re-evaluation means the bot's post-delivery build phase (up to 20M) is guided by an outdated plan. Fixing both parts ensures decisions reflect the bot's actual hand and the LLM can react to new opportunities immediately.

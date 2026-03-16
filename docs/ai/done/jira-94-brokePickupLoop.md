# JIRA-94: Broke Bot Pickup/Drop Loop

## Problem

When a bot is broke ($0M) with no affordable demands, the heuristic fallback picks up loads it can never deliver, then drops them next turn, creating an infinite waste loop.

### Root Cause

In `ActionResolver.heuristicFallback()`, the priority order is:

1. Deliver (step 1)
2. **Pickup (step 1b)** — fires if `canPickup.length > 0`
3. **Broke discard (step 1c)** — fires if `money < 5 && demands.every(d => !d.isAffordable)`
4. Move (step 2)
5. Build (step 3)
6. Drop dead load (step 4)
7. Discard dead hand (step 5)
8. Pass (step 6)

Step 1b returns before step 1c ever runs. The bot picks up a useless load, then on the next turn step 4 drops it, then step 1b picks it up again — infinite loop.

### Example: Game f21a8cd5

Flash bot (Gemini 3 Flash) at $0M from T9 onwards:

- T9: $0M, builds $5M track (drains last cash)
- T10: $0M, LLM plans but discards hand (correct)
- T11: $0M, LLM fails → heuristic **DropLoad** (drops the useless load from previous pickup)
- T12: $0M, LLM fails → heuristic **DiscardHand** (finally discards, but only because no load to drop/pickup this turn)
- T13: $0M, LLM fails → heuristic **PickupLoad** (picks up another useless load — loop restarts)

The only action that helps a broke bot with unaffordable demands is **discard hand** — get new demand cards that hopefully match the existing network.

## Fix

Skip step 1b (pickup) when the bot is broke with no affordable demands:

```typescript
// 1b. Try to PICKUP if there are available loads at current position
// JIRA-94: Skip pickup when broke — picking up a load you can't afford to deliver
// just creates a drop/pickup loop. The bot needs to discard for new demand cards.
const isBrokeWithNoAffordableDemands = snapshot.bot.money < 5 && context.demands.every(d => !d.isAffordable);
if (context.canPickup && context.canPickup.length > 0 && !isBrokeWithNoAffordableDemands) {
```

This lets the broke-discard check at step 1c fire correctly.

## Files to Modify

- `src/server/services/ai/ActionResolver.ts` — step 1b guard condition
- `src/server/__tests__/ai/ActionResolver.test.ts` — test verifying broke bot skips pickup

# JIRA-82: Phantom Carried Load After Delivery — ContextBuilder Reports Delivered Load as Still on Train

## Bug Description

After delivering a load mid-route, the demand ranking system continues to report the load as "carried on train" (`isLoadOnTrain: true`, `supplyCity: "Unknown"`) for the rest of the game. This causes the LLM to plan routes with a phantom "deliver X at Y" stop that can never be executed because the load isn't actually on the train.

## Evidence

### Game `17684b7c`, Gemini bot (c14e8b94):

**T14**: Gemini delivers Wheat at Firenze (17M payout). Load removed from train. New demand card drawn.

**T15-T33 (19 turns!)**: Every demand ranking shows Wheat with:
- `supplyCity: "Unknown"` (meaning "already carried on train")
- `isLoadOnTrain: true`
- `estimatedTurns: 1`
- `trackCostToSupply: 0`

Every LLM route plan from T15-T33 includes "deliver(Wheat@Firenze)" as a final stop. The bot never goes to Firenze because higher-value stops are always prioritized first, but the phantom Wheat poisons every route plan.

## Root Cause

In `ContextBuilder.computeSingleSupplyDemandContext()` (line 477):

```typescript
const isLoadOnTrain = snapshot.bot.loads.includes(loadType);
```

This checks `snapshot.bot.loads` which is the **turn-start** snapshot. After a delivery happens in TurnExecutor, the snapshot's loads are updated for subsequent action execution, but the **demand ranking rebuild** in AIStrategyEngine (line 463-464) uses a fresh snapshot:

```typescript
const freshSnapshot = await capture(gameId, botPlayerId);
context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
```

The issue is that if a **second demand card** for the same load type exists in hand after delivery (Gemini drew another Wheat card), `isLoadOnTrain` correctly returns `false` for the NEW card. But the `supplyCity` lookup fails because the new card demands Wheat from a different source, and the system falls back to "Unknown" supply (implying carried).

**Actual root cause**: The `supplyCity` for a demand is determined by scanning `loadAvailability` in the snapshot. If the load type exists on `snapshot.bot.loads`, it returns `supplyCity: "Unknown"`. But after delivery, the load is NOT on `bot.loads` — so the real question is why does the game log show `supplyCity: "Unknown"` for Wheat post-delivery?

Possible causes:
1. The `rebuildDemands` call at line 464 uses a snapshot where `bot.loads` still includes Wheat (stale capture)
2. The demand card drawn after delivery happens to also be a Wheat card, and the availability check for Wheat supply cities returns no results (all Wheat chips are in the tray, none at cities), causing a fallback to "Unknown"
3. A race condition in the DB capture timing

## Affected Files

- `src/server/services/ai/ContextBuilder.ts:472-477` — `computeSingleSupplyDemandContext` isLoadOnTrain check
- `src/server/services/ai/ContextBuilder.ts` — `rebuildDemands` and how it handles supply city lookup
- `src/server/services/ai/AIStrategyEngine.ts:462-464` — Post-delivery demand rebuild timing

## Impact

Every route plan for the rest of the game includes a phantom stop that can never be executed. The LLM wastes context window on this phantom stop and may deprioritize real stops to accommodate it. In game 17684b7c, Gemini planned "deliver Wheat@Firenze" on 19 consecutive turns without ever going there.

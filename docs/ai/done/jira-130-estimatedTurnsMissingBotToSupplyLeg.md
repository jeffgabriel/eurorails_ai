# JIRA-130: estimatedTurns Ignores Bot→Supply Travel Leg

_The non-cold-start path in `ContextBuilder.computeSingleSupplyDemandContext` computes `travelTurns` using only the supply→delivery hop distance, completely ignoring the bot's current position→supply leg. This causes the LLM to drastically underestimate turn counts for distant pickups._

## Evidence from Game `361153a6` (Flash)

Towards the end of the game, Flash was in **Berlin** and evaluated delivering **oranges from Valencia** to central Europe. The estimated turns showed ~5 (Valencia→delivery only), but the true cost was ~10 turns (Berlin→Valencia→delivery). Flash pursued the route based on the underestimate, wasting turns on a suboptimal demand.

## Root Cause

In `ContextBuilder.ts`, the travel distance calculation has three branches:

| Branch | Path | Bot→Supply Leg | Supply→Delivery Leg |
|--------|------|:-:|:-:|
| Cold-start (line 602) | `startingCity → supply → delivery` | ✅ Computed | ✅ Computed |
| Non-cold-start (line 649) | `supply → delivery` only | ❌ **Missing** | ✅ Computed |
| On-train (line 677) | `bot → delivery` | ✅ Computed (recent fix) | N/A |

The non-cold-start branch at line 649 has this comment:

```
// Non-cold-start: supply→delivery (bot is already on network)
```

The assumption "bot is already on network" is correct, but the conclusion that only supply→delivery matters is wrong — the bot still needs to **travel to the supply city first**.

The cold-start path (lines 602-648) correctly computes both legs (`startingCity → supply` + `supply → delivery`). The non-cold-start path was never updated to include the bot→supply leg.

## Impact

- **Demand scoring is wrong**: `estimatedTurns` feeds into `scoreDemand()` via `baseROI = (payout - trackCost) / estimatedTurns`. Underestimating turns inflates ROI, making distant pickups look better than they are.
- **Efficiency metric is wrong**: `efficiencyPerTurn = (payout - trackCost) / estimatedTurns` is shown directly to the LLM in the prompt. The LLM sees "4.5M/turn" when the real efficiency is "2.3M/turn".
- **Route selection is wrong**: The LLM picks routes with high apparent efficiency that are actually poor when accounting for the pickup travel.

## Fix

Modify the non-cold-start branch (line 649) to compute both legs:

1. **Leg 1: bot position → supply** — Use `estimateHopDistance(botPos, supplyPoint)` with Euclidean fallback
2. **Leg 2: supply → delivery** — Existing logic (unchanged)
3. **Total**: `travelTurns = Math.ceil((hopBotToSupply + hopSupplyToDelivery) / speed)`

When `snapshot.bot.position` is null, fall back to existing behavior (supply→delivery only).

This mirrors the cold-start path's two-leg pattern but uses `snapshot.bot.position` instead of `optimalStartingCity`.

## Affected Code

- `src/server/services/ai/ContextBuilder.ts:649-675` — Non-cold-start travel distance block
- `src/server/__tests__/ai/ContextBuilder.test.ts` — New unit tests

## Acceptance Criteria

- [ ] Non-cold-start `travelTurns` includes bot→supply + supply→delivery distance
- [ ] Bot in Berlin evaluating Valencia→central Europe route sees ~10 turns, not ~5
- [ ] Cold-start path behavior unchanged
- [ ] On-train path behavior unchanged (previous fix)
- [ ] Null bot position gracefully falls back to supply→delivery only
- [ ] All existing tests pass
- [ ] New unit tests cover bot→supply→delivery estimation

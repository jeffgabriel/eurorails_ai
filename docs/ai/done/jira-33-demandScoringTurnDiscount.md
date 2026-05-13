# JIRA-33: Demand Scoring — Turn-Count Discount on Corridor & Victory Bonuses

**Date:** 2026-03-05
**Priority:** High
**Related bugs:** Bug 4 (Flash overextends to Barcelona+Napoli), Bug 3 (bots build toward Roma and stop short)

---

## Problem

The demand scoring formula in `ContextBuilder.scoreDemand()` penalizes distance in `baseROI` (divides by `estimatedTurns`), but the **corridor bonus and victory bonus are not discounted by turns**. This means long routes that sweep across the map accumulate large bonuses from passing near many cities and unconnected major cities, overwhelming the per-turn ROI penalty.

**Example:** "Potatoes to Milano" — Belfast is selected as supply city over Lodz/Szczecin because the Belfast→Milano corridor passes through 8+ cities and 2-3 unconnected major cities. The victory bonus alone adds ~13.5M (3 cities × 30M × 0.15) as a flat number, dwarfing the baseROI difference between a 3-turn Lodz route and a 10-turn Belfast route.

**Current formula:**
```typescript
baseROI = (payout - totalTrackCost) / estimatedTurns
corridorMultiplier = min(networkCities * 0.05, 0.5)
victoryBonus = victoryMajorCities * max(payout * 0.15, 5)
score = baseROI + (corridorMultiplier * baseROI) + victoryBonus
```

The corridor multiplier scales with baseROI (which includes turn discount) — that part is fine. But `victoryBonus` is a flat additive term with **no turn discount**. A 10-turn route with 3 victory cities scores the same victory bonus as a 3-turn route with 3 victory cities.

---

## Proposed Fix

Divide `victoryBonus` by `estimatedTurns` so that distant victory cities are valued proportionally to how quickly the bot can actually reach them:

```typescript
baseROI = (payout - totalTrackCost) / estimatedTurns
corridorMultiplier = min(networkCities * 0.05, 0.5)
victoryBonus = (victoryMajorCities * max(payout * 0.15, 5)) / estimatedTurns
score = baseROI + (corridorMultiplier * baseROI) + victoryBonus
```

**Effect on the Belfast vs Lodz example:**
- Belfast (10 turns, 3 victory cities, 30M payout): victoryBonus = (3 × 4.5) / 10 = 1.35
- Lodz (3 turns, 1 victory city, 30M payout): victoryBonus = (1 × 4.5) / 3 = 1.5
- Lodz now wins on victory bonus despite fewer cities, because it's achievable 3× faster

The corridor multiplier already scales with baseROI (which is turn-discounted), so it doesn't need a separate fix.

---

## File to Change

| File | Change |
|------|--------|
| `src/server/services/ai/ContextBuilder.ts` | Line 1576: divide victoryBonus by `estimatedTurns` |

---

## Verification

1. `npx tsc --noEmit` — no new type errors
2. `npm test` — existing tests pass (integration tests in `test_corridor_rebalance.test.ts` may need threshold updates)
3. Manual: start a game, verify in debug overlay that nearby supply cities score higher than distant ones for the same demand

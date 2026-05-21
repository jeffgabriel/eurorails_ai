# JIRA-22: LLM Chooses Long Routes and Calls Them "Quick Cash"

---

## What Happened

The bot repeatedly picks high-payout demands that require many turns to complete, even when faster, cheaper deliveries are available. It labels these long routes as "quick cash" in its reasoning, despite the system prompt explicitly teaching capital velocity.

Example observed behavior:
- A 42M delivery requiring ~9 turns of building and travel is chosen over a 15M delivery completable in ~2 turns
- The bot rationalizes the slow delivery as "quick cash" because the payout is large
- Meanwhile it earns zero income for 8+ turns, falling behind on capital accumulation

## Why It Happens

The demand ranking shown to the LLM contradicts the capital velocity teaching. Two compounding problems:

### 1. Scoring ignores delivery speed entirely

The `scoreDemand` formula is:
```
score = (payout - buildCost) + networkCities × 3 + victoryMajorCities × 10
```

This measures **total profit** with zero regard for how many turns the delivery takes. A 42M delivery with 25M build cost scores 17 (plus bonuses). A 15M delivery with 2M build cost scores 13 (plus bonuses). The slow delivery ranks higher and gets the `← RECOMMENDED` tag.

### 2. The LLM has no concrete efficiency metric

The prompt shows:
```
DEMAND RANKING (by investment value):
  #1 Wine Bordeaux→Stockholm: score 32 (payout: 42M, build: ~25M, ROI: 17M, ~9 turns, ...) ← RECOMMENDED
  #2 Cheese Paris→Berlin: score 14 (payout: 15M, build: ~2M, ROI: 13M, ~2 turns, ...)
```

The LLM can see the turn estimates, but the ranking and RECOMMENDED tag point to the wrong option. The system prompt says "ask how many turns until paid" but the data says "pick the highest score." The LLM resolves this contradiction by rationalizing — it picks the RECOMMENDED option and calls it quick cash.

## What Should Happen

The scoring should reward **efficiency** (profit per turn), not just total profit. And the LLM should see an explicit M/turn metric so it can evaluate capital velocity without guessing.

**Corrected ranking:**
```
DEMAND RANKING (by investment value):
  #1 Cheese Paris→Berlin: score 9.5 (payout: 15M, build: ~2M, ROI: 13M, ~2 turns, 6.5M/turn, ...) ← RECOMMENDED
  #2 Wine Bordeaux→Stockholm: score 4.9 (payout: 42M, build: ~25M, ROI: 17M, ~9 turns, 1.9M/turn, ...)
```

Now the RECOMMENDED tag aligns with the capital velocity teaching. The 2-turn delivery ranks first because it earns 6.5M per turn vs 1.9M per turn.

## Changes Required

### A. Fix scoring formula to reward speed

In `scoreDemand` (`ContextBuilder.ts` ~line 1415):

Current: `score = immediateROI + networkBonus + victoryBonus`

New: `score = (immediateROI / estimatedTurns) + networkBonus + victoryBonus`

This divides raw profit by the number of turns, so faster deliveries score higher per unit of time invested.

### B. Show M/turn in the demand ranking prompt

In `serializePrompt` (`ContextBuilder.ts` ~line 624), add `X.XM/turn` to the ranking line so the LLM has a concrete efficiency number to reason with.

### C. Add `efficiencyPerTurn` field to DemandContext

In `GameTypes.ts` (~line 581), add `efficiencyPerTurn: number` to the `DemandContext` interface so the computed value is available for both scoring and serialization.

## Files to Modify

| File | What changes |
|------|-------------|
| `src/server/services/ai/ContextBuilder.ts` | `scoreDemand()`: divide ROI by turns. `serializePrompt()`: add M/turn. Call site: pass estimatedTurns to scoreDemand. |
| `src/shared/types/GameTypes.ts` | Add `efficiencyPerTurn` to `DemandContext` interface |

## Verification

1. `npm test` — update any assertions that check `demandScore` values
2. Review a serialized prompt to confirm ranking favors fast deliveries and shows M/turn
3. Manual gameplay: bot should prefer short deliveries early-game instead of chasing distant high-payout routes

# JIRA-174: Multiplicative Penalty Inversion for Negative Scores

**Status:** Done

## Bug: ALL multiplicative penalties invert for negative scores

**File:** `src/server/services/ai/ContextBuilder.ts:2290-2305`

**Problem:** The build cost ceiling penalty and affordability penalty both multiply the score by a factor < 1. When the score is negative (which it almost always is), multiplying by a small factor makes the score LESS negative — pushing it closer to zero and ranking it HIGHER. This means more expensive, more unaffordable routes get BETTER scores.

**Example — Oranges Sevilla→Manchester (127M build, 16 turns, ferry):**
```
baseROI = (40 - 127) / 16 = -5.44
rawScore ≈ -4.2 (after corridor dampening)
costPenalty = exp(-(127-50)/30) = 0.077
penalizedScore = -4.2 × 0.077 = -0.32  ← penalty HELPS the route!
affordabilityPenalty ≈ 0.03
finalScore = -0.32 × 0.03 = -0.01      ← nearly zero = ranks #2!
```

**Compare Ham Warszawa→Praha (18M build, 4 turns, no ferry):**
```
baseROI = (13 - 18) / 4 = -1.25
rawScore ≈ -0.96
costPenalty = 1.0 (18M < 50M threshold)
affordabilityPenalty ≈ 0.29
finalScore = -0.96 × 0.29 = -0.28      ← ranks #8, worse than 127M route!
```

**Root cause:** Multiplicative penalties cannot be applied to scores that can be negative. Every `score * penalty_factor` where `penalty_factor < 1` and `score < 0` makes the result LESS negative (= better ranking). This affects:
1. Build cost ceiling penalty: `rawScore * costPenalty`
2. Affordability penalty: `penalizedScore * penalty`

Both the original affordability penalty AND the newly added build cost ceiling had this inversion.

## Fix Applied

Commit `73972d0`: When score is negative, divide by penalty factor instead of multiplying. This makes penalties always push scores further from zero (= worse ranking).

Files changed:
- `src/server/services/ai/ContextBuilder.ts` — scoreDemand penalty application
- `src/server/__tests__/ai/integration/integrationTestSetup.ts` — test replica synced

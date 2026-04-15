# JIRA-173: Demand Ranking Algorithm Bugs

## Bug 1: ROI formula inverts ranking for net-negative routes

**File:** `src/server/services/ai/ContextBuilder.ts:2281`

**Formula:** `baseROI = (payout - totalTrackCost) / estimatedTurns`

**Problem:** When both routes are net-negative (build cost > payout), dividing by more turns makes a worse route look *better*. The formula was designed for profitable routes where more turns = less efficient = lower score, but for unprofitable routes the math flips.

**Example from Haiku's game:**
| Route | Loss | Turns | Score |
|-------|------|-------|-------|
| Sheep Cork→Sarajevo | -50M | 16 | -0.49 |
| Flowers Holland→Wien | -13M | 6 | -1.00 |
| Ham Warszawa→Praha | -11M | 5 | -1.18 |

Sheep loses 50M but ranks #3 because spreading -50M over 16 turns = -3.13/turn looks better than -13M over 6 turns = -2.17/turn. Flowers→Wien and Ham→Praha are objectively better (affordable, short, cheap) but rank last.

**Additional observation:** Any route with build cost >50M is almost always a bad investment. The algorithm has no penalty for extreme build costs.

**Root cause:** For net-negative ROI, dividing by turns inverts the ordering. Total loss matters more than loss rate for unprofitable routes.

**Fix options:**
1. For net-negative ROI routes, use `payout - totalTrackCost` (total loss) without dividing by turns
2. Add a build cost ceiling penalty (e.g., exponential penalty above 50M)
3. Separate profitability signal from efficiency signal in the scoring formula

---

## Bug 2: Supply city selection picks wrong city due to Bug #4 (corridor multiplier inversion)

**File:** `src/server/services/ai/ContextBuilder.ts:499-511, 2281-2283`

**Problem:** `computeBestDemandContext` evaluates all supply cities and picks the one with the highest `demandScore`. The cost estimation is correct — but the scoring formula (Bug #4) inverts the ranking for supply cities near major city corridors.

**Confirmed by simulation — Beer→Antwerpen cold start:**

| Supply | Build Cost | Turns | baseROI | Corridor Cities | Multiplier | rawScore | demandScore |
|--------|-----------|-------|---------|----------------|------------|----------|-------------|
| Dublin | 32M | 5 | -4.40 | 3 | 0.15 | -5.06 | **-2.37** (WINS) |
| Frankfurt | 22M | 4 | -3.00 | 8 | 0.40 | -4.20 | **-2.86** (LOSES) |
| München | 29M | 5 | -3.80 | 6 | 0.30 | -4.94 | -2.56 |
| Praha | 32M | 5 | -4.40 | 5 | 0.25 | -5.50 | -2.58 |

Frankfurt has the best baseROI (-3.0) and lowest build cost (22M) but its corridor passes through 8 cities (Ruhr, Holland, etc.), giving it a 0.40 corridor multiplier. With negative ROI, `rawScore = -3.0 × 1.40 = -4.20` — the corridor *punishes* Frankfurt for being near strategically valuable cities. Dublin has fewer corridor cities (0.15 multiplier), so its worse ROI gets less amplification.

**This is Bug #4 in action.** The corridor multiplier was designed to reward routes through major cities, but when ROI is negative (which is virtually always during cold start since payout < build cost), the multiplier amplifies the penalty instead. Better-positioned supply cities are systematically penalized.

**This bug is devastating in practice:** every bot, every game picks absurd supply cities during the initial build phase. Beer from Dublin instead of Frankfurt next door. Cattle from Nantes instead of Bern. Steel from Birmingham (cross-ferry!) instead of Ruhr.

**Root cause:** Same as Bug #4 — multiplying a negative ROI by `(1 + corridorMultiplier)` makes it more negative. The fix for Bug #4 will fix this.

**Additional warm-start issue:** When the bot has an existing network, `estimateTrackCost` computes supply and delivery costs independently. An on-network supply city on the wrong side of a ferry (e.g., Birmingham for Steel→Warszawa) gets supply cost = 0, masking the expensive cross-ferry delivery path. A holistic supply→delivery cost comparison would catch this.

---

## Bug 3: Ferry detection misses Scandinavian routes

**File:** `src/server/services/ai/ContextBuilder.ts:2654-2694`

**Problem:** `isFerryOnRoute` classifies cities into 3 regions: 'britain', 'ireland', 'continent'. Oslo, Stockholm, Kobenhavn, Goteborg, etc. are all classified as 'continent'. Routes between Scandinavian cities and mainland Europe (e.g., Oslo→Holland) show no ferry required, even though practically reaching Scandinavia from central Europe requires ferry crossings through Denmark/Sweden.

**Example:** Wood Oslo→Holland shows no ferry flag (⛴), but getting from Oslo to Holland practically requires crossing water (Kattegat/Skagerrak ferries or long overland through Denmark).

**Note:** This is "technically true but practically false" — the hex grid may have continuous land connections through Denmark, but the travel distance and terrain make it functionally similar to a ferry route. The turn estimate may be underestimated as a result.

**Root cause:** The region classification only models Channel and Irish Sea crossings. Scandinavian ferry routes are not classified as water barriers.

**Fix options:**
1. Add a 'scandinavia' region for Norwegian/Swedish cities and detect crossings to 'continent'
2. Or accept this as a turn estimation issue rather than a ferry flag issue — ensure `estimateHopDistance` correctly accounts for the long overland route through Denmark

---

## Bug 4: Corridor multiplier penalizes good routes when ROI is negative

**File:** `src/server/services/ai/ContextBuilder.ts:2281-2283`

**Formula:**
```
baseROI = (payout - totalTrackCost) / estimatedTurns
corridorMultiplier = min(networkCities * 0.05, 0.5)
rawScore = baseROI * (1 + corridorMultiplier)
```

**Problem:** When `baseROI` is negative (which it is for virtually all early-game demands where build cost > payout), multiplying by `(1 + corridorMultiplier)` makes the score MORE negative. Routes that pass through more cities — which should be strategically valuable — get worse scores.

**Example:** Cattle→Berlin, comparing Bern vs Nantes as supply:
- **Bern→Berlin corridor:** 10 cities → multiplier 0.50 → score = negative_ROI × 1.5
- **Nantes→Berlin corridor:** 8 cities → multiplier 0.40 → score = negative_ROI × 1.4

Bern passes through more major cities (Zurich, Frankfurt, München, Stuttgart) — a strategically superior route — but gets penalized for it. The corridor bonus becomes a corridor penalty whenever ROI is negative.

**Root cause:** Multiplying a negative number by a value > 1 makes it more negative. The formula assumes baseROI is positive.

**Fix:** When `baseROI < 0`, divide by `(1 + corridorMultiplier)` instead of multiplying, so corridor value dampens the penalty rather than amplifying it. Or restructure the formula to apply corridor value as an additive bonus rather than a multiplicative one.

---

## Bug 5: ALL multiplicative penalties invert for negative scores

**File:** `src/server/services/ai/ContextBuilder.ts:2290-2305`

**Problem:** The build cost ceiling penalty (line 2295) and affordability penalty (line 2301) both multiply the score by a factor < 1. When the score is negative (which it almost always is), multiplying by a small factor makes the score LESS negative — pushing it closer to zero and ranking it HIGHER. This means more expensive, more unaffordable routes get BETTER scores.

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
1. Build cost ceiling penalty (line 2295): `rawScore * costPenalty`
2. Affordability penalty (line 2301): `penalizedScore * penalty`

Both the original affordability penalty AND the newly added build cost ceiling have this inversion.

**Fix:** Convert all penalties to work correctly with negative scores. Options:
1. Apply penalties to the absolute value, then restore sign: `sign(score) * abs(score) * penalty` → ensures penalties always make the score worse
2. Divide negative scores by penalty instead of multiplying: `negScore / penalty` makes it MORE negative
3. Convert to an additive penalty system: `score - penaltyAmount` always makes scores worse regardless of sign
4. Restructure the score to be non-negative (e.g., score = max(0, payout - cost) / turns + corridor_bonus) and apply penalties only to the base positive component

# JIRA-88: Belfast Ferry Blind Spot — LLM Treats Island Cities as Mainland

## Bug Description

In game `15d203e2`, Haiku bot treats Belfast as "quick cash" at turn 27, stating the route "doesn't require expensive ferry crossings" — yet Belfast requires **two** ferry crossings from mainland Britain (English Channel + Irish Sea), each with a 1-turn stop penalty and half-rate movement the following turn, plus ECU 4M build cost for the Belfast ferry port per the rules.

The LLM was never told Belfast requires a ferry because the demand scoring pipeline has three independent gaps that compound into a single blind spot.

## Evidence

### Game `15d203e2`, Bot `becd5d1b`

**Belfast demand (China to Belfast, 15M payout) progression:**

| Turn | estimatedTurns | trackCostToDelivery | ferryRequired | Score |
|------|:-:|:-:|:-:|:-:|
| 5 | 8 | 27 | (absent) | — |
| 12 | 4 | 14 | (absent) | — |
| 27 | 1 | 0 | (absent) | 15 (rank #1) |
| 28 | 1 | 0 | (absent) | 15 (rank #1) |

By turn 27, Belfast shows `trackCostToDelivery: 0` and `estimatedTurns: 1` — identical to a mainland city 1 milepost away. The bot prioritized it as the best demand and built toward it.

**LLM reasoning (Turn 27, attempt 3 — accepted):**
> "You're already carrying China on your train. Deliver it to Belfast (15M payout in ~2 turns) to generate quick cash. This is the only immediately playable demand that doesn't require expensive ferry crossings or track building you can't afford."

The irony is explicit: the LLM specifically says Belfast doesn't require ferry crossings, because nothing in its context indicated otherwise.

**Turn 27 stored reasoning:**
> "[route-planned] You're already carrying China on your train. Deliver it to Belfast (15M payout in ~2 turns) to generate quick cash..."

**Turn 28:**
> "[route-executor] [PlanExecutor stop=1/2] Building toward Belfast"

## Root Cause — Three Independent Defects

### Defect 1: `ferryRequired` absent from demand ranking payload

The `DemandContext` interface has a `ferryRequired: boolean` field, and `ContextBuilder.scoreDemand()` computes it. But the demand ranking serialized in `AIStrategyEngine.ts:620-633` does not include `ferryRequired` in the mapped object. The field is computed but never reaches the LLM prompt or the debug overlay.

**Affected code:**
- `src/server/services/ai/AIStrategyEngine.ts:620-633` — demand ranking `map()` omits `ferryRequired`

**Fix:** Add `ferryRequired: d.ferryRequired` to the ranking map at line 620-633. Also add it to the `BotTurnResult.demandRanking` type and the `DebugOverlay.renderDemandRanking()` display.

### Defect 2: `estimatePathCost` does not include ferry port build costs

The path cost estimator (`ContextBuilder.estimatePathCost` or `MapTopology.estimateHopDistance`) calculates track building cost using terrain costs (clear=1M, mountain=2M, alpine=5M, small city=3M, medium city=3M, major city=5M). But ferry port build costs are not included. Belfast requires two ferry crossings (English Channel + Irish Sea) with associated port build costs (ECU 4M for Belfast port per the rules, plus Channel ferry costs), and none of this is reflected in `trackCostToSupply` / `trackCostToDelivery`.

**Affected code:**
- `src/server/services/ai/ContextBuilder.ts` — `estimatePathCost()` or related cost computation
- `src/server/services/ai/MapTopology.ts` — `estimateHopDistance()` if it contributes to cost

**Fix:** When the BFS/pathfinding crosses a ferry route, add the ferry port build cost to the estimated track cost. Ferry costs are specified on the map per-route (e.g., Belfast = ECU 4M, Dublin = ECU 8M). This data should already exist in the map topology.

### Defect 3: `estimatedTurns` does not account for ferry stop + half-rate penalty

Per the game rules, using a ferry requires:
1. Move to the ferry port and **stop movement for that turn** (1 full turn lost)
2. On the next turn, start counting from the opposite ferry port and **move at half rate** (Freight: 5 instead of 9, Fast Freight: 6 instead of 12)

The turn estimator does not account for either penalty. Belfast requires **two** ferry crossings (Channel + Irish Sea), meaning ~3-4 extra turns that are completely invisible to the scoring system. Currently the estimate adds 0 turns for ferries.

**Affected code:**
- `src/server/services/ai/ContextBuilder.ts` — `estimatedTurns` computation (likely in `scoreDemand` or a helper)
- `src/server/services/ai/MapTopology.ts` — BFS hop distance if it feeds turn estimation

**Fix:** When a route crosses a ferry, add the ferry penalty to `estimatedTurns`:
- +1 turn per ferry for the mandatory stop at the ferry port
- +0.5 turns per ferry (approximate) for the half-rate movement on the next turn
- This could be simplified to `+2 turns` per ferry crossing as a conservative estimate
- Belfast (2 ferries) would add ~3-4 turns; Dublin (1 ferry from Britain) would add ~1.5-2 turns

## Impact

Without ferry awareness, the demand scoring system systematically overvalues island destinations (Belfast, Dublin, and any city reachable only via ferry). Belfast is the worst case — requiring two ferry crossings (Channel + Irish Sea) means ~3-4 hidden turns and significant ferry build costs that the scorer reports as 0. The LLM receives inflated scores for these demands and may prioritize them over genuinely accessible mainland demands. In game `15d203e2`, this caused the bot to waste turns 27-28 building toward Belfast instead of pursuing a mainland delivery.

This affects all three LLM providers (Haiku, Flash, Pro) since the context is provider-agnostic.

## Affected Files Summary

| File | Defect | Change |
|------|--------|--------|
| `src/server/services/ai/AIStrategyEngine.ts:620-633` | #1 | Add `ferryRequired` to ranking map |
| `src/shared/types/GameTypes.ts` | #1 | Add `ferryRequired` to `BotTurnResult.demandRanking` type |
| `src/client/components/DebugOverlay.ts` | #1 | Display ferry indicator in ranking table |
| `src/server/services/ai/ContextBuilder.ts` | #2, #3 | Add ferry cost to path estimation, add ferry penalty to turn estimation |
| `src/server/services/ai/MapTopology.ts` | #2, #3 | Add ferry awareness to BFS/hop distance if applicable |

## Priority

HIGH — Ferry-blind scoring creates a systematic bias toward island cities that compounds over a full game. Every demand involving Belfast, Dublin, or other ferry-dependent cities is mis-scored.

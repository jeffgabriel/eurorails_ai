# JIRA-59: Stuck Counter Not Reset on LLM Success

## Bug Description

The guardrail enforcer's progress-based stuck detection counter doesn't reset when the LLM successfully produces a valid plan. This causes the guardrail to override valid LLM plans with DiscardHand even when the bot has a clear path forward.

## Evidence

Game `ff240679`, Flash (gemini-3-flash-preview):

- **Turn 8**: heuristic-fallback (LLM planning failed). Stuck counter = 1.
- **Turn 9**: heuristic-fallback. Stuck counter = 2.
- **Turn 10**: heuristic-fallback. Stuck counter = 3. Guardrail forces DiscardHand.
- **Turn 11**: LLM **successfully** planned a route (Iron Birmingham→Zurich, score 5.2, 1 attempt, valid plan). But stuck counter = 4 because it wasn't reset by the T10 discard or the T11 LLM success. Guardrail forces DiscardHand **again**, destroying a valid plan.

The T11 discard is especially wasteful: Flash had good cards (Iron→Zurich 24M rank 1, Wheat→Manchester 24M rank 2, Wheat→Aberdeen 37M rank 3 — hand quality "Good" at 3.22) and a successful LLM route, but the guardrail killed it.

## Root Cause

The stuck detection counter tracks consecutive turns without deliveries, cash increase, or new cities. It increments every turn regardless of whether:
1. The LLM produced a valid plan
2. The bot is actively executing a route (en route to pickup/delivery)
3. A DiscardHand already fired (which should reset the counter since the bot now has new cards)

## Affected Files

- `src/server/services/ai/GuardrailEnforcer.ts` — stuck detection logic

## Fix

Reset the stuck counter when:
1. A DiscardHand is executed (bot has new cards, fresh start)
2. The LLM successfully produces a valid route plan (bot has a direction)
3. The bot picks up a load (progress toward delivery)

At minimum, a DiscardHand MUST reset the counter — otherwise the bot enters a discard loop where it keeps discarding good hands.

# JIRA-51: Demand Scoring Gives Positive Scores to Demands the Bot Can't Afford to Deliver

**Severity:** High
**Source:** Game `2d3d214b` analysis — Flash (gemini-3-flash-preview)

## Problem

The demand scoring system rates demands as attractive even when the bot doesn't have enough cash to build the track needed to deliver them. This causes the bot to chase loads it can never deliver, wasting turns and accelerating cash starvation.

## Evidence — Game `2d3d214b`

**Flash at T14 (1M cash):**
- Sheep Bilbao→Ruhr: score 2.63, but trackCostToSupply=14M — bot is 13M short
- Wheat Lyon→Stockholm: score 0.63, but trackCostToDelivery=47M — bot is 46M short
- Coal (carrying)→Göteborg: trackCostToDelivery=33M — bot is 32M short

All three demands had positive scores. None were deliverable. The LLM trusted these scores and planned a 7-turn trip to pick up Wheat — which it then had to drop because it couldn't go anywhere.

A discard would have been the right play here, but the scoring system said the hand was worth pursuing.

## Expected Behavior

Demands that require more track investment than the bot can currently afford should be scored much lower — or flagged so the LLM knows they're aspirational rather than actionable. When ALL demands in hand are unaffordable, the scoring should signal that a hand discard is the best option.

## Files

- `src/server/services/ai/ContextBuilder.ts` (demand scoring / formatReachabilityNote)
- `src/server/services/ai/TurnComposer.ts` (demand ranking used for build targeting)

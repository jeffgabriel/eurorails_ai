# JIRA-153: ContextBuilder demand ranking picks wrong supply city

## Problem

Game e179466e: Demand card for Cars→Berlin (10M). Stuttgart produces Cars and is ~15M build cost from Berlin. But the demand ranking shows `Cars Manchester→Berlin costToSupply=41` — Manchester is in Britain, requires a ferry, and is absurdly far from Berlin.

The demand ranking evaluates all supply cities and picks the one with the best `demandScore` (ContextBuilder.ts line 506). Manchester scored higher than Stuttgart despite being geographically worse. This means the `demandScore` formula or the `computeSingleSupplyDemandContext` cost estimation is broken for cold-start supply city selection.

## Root Cause (suspected)

`computeSingleSupplyDemandContext` computes `demandScore` using a combination of payout, estimated turns, track costs, and other factors. On cold start (no track built), the cost estimation may be producing misleading results — possibly:

1. The cold-start hub model (JIRA-72) picks a starting city that makes Manchester look cheap
2. The ferry cost isn't being penalized enough in the score formula
3. The supply rarity bonus is inflating Manchester's score (if Manchester is the only UK source for Cars)

## Location

- `src/server/services/ai/ContextBuilder.ts` lines 499-508 — supply city selection loop
- `src/server/services/ai/ContextBuilder.ts` `computeSingleSupplyDemandContext()` — scoring function
- The `demandScore` formula and its interaction with cold-start cost estimation

## Impact

The demand ranking informs the LLM's route planning during non-initial-build turns. A wrong supply city in the ranking misleads the LLM into planning routes toward the wrong city. The InitialBuildPlanner has its own supply city evaluation (unaffected), but post-initial-build turns rely on ContextBuilder's ranking.

## Investigation needed

- Trace `computeSingleSupplyDemandContext` for Cars/Manchester/Berlin vs Cars/Stuttgart/Berlin and compare the demandScore components
- Check if ferry penalty is applied to the score
- Check if cold-start hub model is selecting a Britain-based hub that makes Manchester look close

# JIRA-49: Build Targeting City with No Affordable Demand

**Severity:** Medium
**Source:** Game `a5766427` analysis — Flash (gemini-3-flash-preview) T5

## Problem

The Phase B build logic spent 19M building track toward Aberdeen when Flash had no affordable demand for that city. The build targeting system chose a destination that would not generate near-term income, wasting limited early-game capital.

This is distinct from JIRA-46 (overall overspend) — the issue here is target selection, not budget discipline. Even with a strict budget, building toward a city with no viable demand is wasteful.

## Evidence — Game `a5766427`, Flash T5

- Flash spent 19M building toward Aberdeen
- Flash had no demand card payable at Aberdeen
- Flash's cash was already low from earlier track building
- The 19M could have been spent building toward a city with an active demand, generating income sooner

## Evidence — Game `2d3d214b`, Flash T14

- Flash had 1M cash and planned a route to pick up Wheat at Lyon for delivery to Stockholm
- Stockholm needed 47M of new track — completely unaffordable
- The LLM also planned to pick up Sheep at Bilbao (14M track needed) — also unaffordable
- LLM reasoning: "Moving to Lyon to utilize existing track for a Wheat pickup, then extending to Bilbao for Sheep"
- Flash spent 5 turns (T14-T18) traveling to Lyon, arrived with 0M, picked up Wheat on T19, then dropped it on T20 because it couldn't go anywhere
- Total waste: 7 turns chasing loads it could never deliver
- Meanwhile Flash was also carrying Coal for Göteborg (33M track needed) — equally undeliverable

## Expected Behavior

Phase B build targeting should prioritize cities where the bot has active demands or where loads can be picked up for existing demands. Building toward cities with no current demand should only happen when connecting major cities for victory track or when all demand cities are already connected.

## Files

- `src/server/services/ai/TurnComposer.ts` (tryAppendBuild — Phase B build target selection)
- `src/server/services/ai/AIStrategyEngine.ts` (strategic build decisions)
- `src/server/services/ai/ContextBuilder.ts` (build guidance in LLM prompt)

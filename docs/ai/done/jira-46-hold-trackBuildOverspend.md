# JIRA-46: Bots Overspend on Track Building Relative to Delivery Income

**Severity:** Medium
**Source:** Game `aaf1bb82` analysis — both bots

## Problem

Both bots spent far more on track building than they earned from deliveries, leaving them cash-starved and unable to recover. The LLM/heuristic builds aggressively toward future demands during Phase B without considering whether the bot can afford to sustain operations.

## Evidence — Game `aaf1bb82`

**Haiku (claude-haiku-4-5):**
- Track spend: 74M (built toward Torino, Roma, Zagreb, Glasgow, Beograd)
- Delivery income: 28M (Cars 13M + Marble 15M)
- Final cash: 4M — could not afford any more track or usage fees

**Flash (gemini-3-flash-preview):**
- Track spend: 60M (built toward Holland, Toulouse, Zagreb, Praha)
- Delivery income: 10M (Cheese 10M)
- Final cash: 0M — completely stuck

Both bots spent >50M on track in the first 8 turns while earning <30M.

## Evidence — Game `2d3d214b`

**Flash (gemini-3-flash-preview):**
- Track spend: 75M — spent 100% of all money ever earned on track
- Delivery income: 25M (Cars 8M + Cheese 17M)
- Final cash: 0M — completely stuck from T13 onward
- Worst offender: heuristic-fallback spent 20M on T11 building toward Bilbao when Flash had 32M cash. Still needed 14M more track to reach Bilbao after the build, but only had 12M left. Never reached Bilbao. Never delivered Sheep.
- Follow-up builds (T12: 5M toward Ruhr, T13: 6M toward Lyon) drained remaining cash to 1M

**Haiku (claude-haiku-4-5):**
- Track spend: 85M
- Delivery income: 81M (Wheat 10M + Tourists 35M + Oranges 36M)
- Final cash: 46M — recovered but only because of high-value Valencia deliveries
- Near-death at T8-T12: 5 turns at 2M cash after spending 50M on track in first 8 turns

The pattern is consistent across games: bots build aggressively without considering whether they can afford to finish the route or sustain operations.

## Possible Fix

Add a cash reserve check before Phase B building: don't spend the full 20M build budget if it would leave the bot below a minimum operating threshold (e.g., 10-15M). Prioritize deliveries that generate income before building speculative track.

## Files

- `src/server/services/ai/TurnComposer.ts` (tryAppendBuild — Phase B build budget)
- `src/server/services/ai/ContextBuilder.ts` (build budget guidance in LLM prompt)
- `src/server/services/ai/AIStrategyEngine.ts` (strategic build decisions)

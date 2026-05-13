# JIRA-53: Bots Never Upgrade from Base Freight Train

**Severity:** Medium
**Source:** Games `2d3d214b`, `aaf1bb82`, `a5766427` — all bots

## Problem

Bots play entire games on the base Freight train (9 mileposts/turn, 2 load capacity) and never upgrade to Fast Freight (12 MP) or Heavy Freight (3 loads). The system generates increasingly urgent upgrade advice but the bots ignore it.

## Evidence — Game `2d3d214b`

**Haiku:** Still on Freight at T20. Upgrade advice started at T4: "You can afford an upgrade (20M)." By T20 the advice was **URGENT**: "Still on Freight at turn 20. Upgrade NOW — every turn without Fast Freight or Heavy Freight costs you efficiency." Never upgraded.

**Flash:** Still on Freight at T20. Never had enough cash after T10 to upgrade (needed 20M, never had more than 12M after that point). The window to upgrade was T10 (32M cash) but the heuristic-fallback spent it all on track instead.

## Impact

- A Fast Freight (12 MP vs 9 MP) saves roughly 1 turn per delivery route — over a 20-turn game with 3 deliveries that's 3 extra turns of productive activity
- A Heavy Freight (3 loads vs 2 loads) would have let Haiku pick up both Oranges at Valencia instead of one
- The 20M upgrade cost typically pays for itself within 2-3 deliveries through saved travel time

## Expected Behavior

The bot should evaluate upgrading when it has enough cash and the game has progressed past the early build phase. Fast Freight is almost always worth 20M by turn 8-10. Heavy Freight is valuable when the bot frequently encounters multiple pickup opportunities at the same city.

## Related

This may be the same issue as JIRA-29 (botNeverUpgradesTrain). If JIRA-29 exists with a different root cause, merge the evidence.

## Files

- `src/server/services/ai/TurnComposer.ts` (Phase B upgrade logic)
- `src/server/services/ai/ContextBuilder.ts` (upgrade advice generation)
- `src/server/services/ai/LLMStrategyBrain.ts` (route planning — should factor in upgrade ROI)

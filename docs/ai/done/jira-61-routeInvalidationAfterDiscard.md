# JIRA-61: Route Not Invalidated After DiscardHand

## Bug Description

When a bot discards its hand (DiscardHand action), the active `StrategicRoute` stored in bot memory is not invalidated, even though the demand cards the route references have been replaced. The route executor continues following the old route for multiple turns until it reaches the pickup city, where the pickup fails with "No demand card matches." This wastes 2-3 turns of movement traveling to a destination the bot can no longer use.

## Evidence

### Game `762d1646`, Flash (gemini-3-flash):
- **T29**: LLM plans route: Flowers Holland→Wien (18M). Route stop 0/2 = pickup Flowers at Holland.
- **T30**: Route executor continues: Moving toward Holland.
- **T31**: Bot discards hand (DiscardHand). Flowers→Wien demand card is gone. New cards: Sheep Bilbao→Stuttgart, Cork Lisboa→Budapest, Wine Wien→Barcelona. **Route still active.**
- **T32**: Route executor continues: Moving toward Holland. `Flowers in demands = false`.
- **T33**: Route executor continues: Moving toward Holland. `Flowers in demands = false`.
- **T34**: Arrives at Holland. Pickup fails: *"No demand card matches 'Flowers'. Only pick up loads you have a demand for."* Route abandoned. PassTurn. **3 turns wasted (T32-T34).**

### Game `762d1646`, Haiku (claude-haiku):
- **T32**: LLM plans route: Machinery Nantes→Milano (20M). Route stop 0/2 = pickup Machinery at Nantes.
- **T35**: Route executor continues: Moving toward Nantes.
- **T36**: Bot discards hand (DiscardHand). Machinery→Milano demand card is gone. **Route still active.**
- **T37**: Route executor continues: Moving toward Nantes. `Machinery in demands = false`.
- **T38**: Arrives at Nantes. Pickup fails: *"No demand card matches 'Machinery'."* Route abandoned. PassTurn. **2 turns wasted (T37-T38).**

## Root Cause

`AIStrategyEngine.takeTurn()` stores the active route in `BotMemory.activeRoute`. When DiscardHand is executed:
1. JIRA-56 refreshes `context.demands` from the new cards (correct)
2. But `memory.activeRoute` is NOT checked against the new demand cards
3. On subsequent turns, `PlanExecutor.execute()` reads the stale route from memory and continues following it
4. The route's pickup/deliver stops reference demand cards that no longer exist

## Fix

In `AIStrategyEngine.takeTurn()`, after detecting a DiscardHand action, validate the active route's stops against the new demand cards. If any stop references a demand card that no longer exists in the bot's hand, clear the route so the LLM re-plans on the next turn.

## Affected Files

- `src/server/services/ai/AIStrategyEngine.ts` — post-discard route validation
- `src/server/__tests__/ai/AIStrategyEngine.test.ts` — test for route invalidation after discard

## Impact

Both bots in game 762d1646 lost 2-3 turns each to this bug (5 turns total). In a 38-turn game, that's ~13% of total turns wasted on futile movement.

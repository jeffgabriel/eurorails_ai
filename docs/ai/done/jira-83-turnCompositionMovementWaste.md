# JIRA-83: Turn Composition Movement Waste — A2 Chain Fails to Use Full Movement Budget

## Bug Description

Multiple turn composition defects cause bots to waste significant movement budget:

1. **A2 "no valid target" after delivery**: After delivering mid-turn, the A2 chain terminates with "no valid target" despite having 5-8 mileposts remaining. JIRA-69 partially fixed this (route index advance + demand cleanup), but the A2 chain still cannot find onward movement targets.

2. **Dead-end track stops**: Bot moves 1-2 mileposts then stops because track network has a dead-end. The bot should continue moving on available track toward its target even if it can't reach the destination.

3. **success:false "Bot is not at a named city"**: Turn reports failure when bot ends movement at an unnamed milepost, despite successful pickups/deliveries earlier in the turn. Build phase may be skipped as a result.

## Evidence

### Game `17684b7c`:

| Turn | Bot | Wasted | Max | Problem |
|------|-----|--------|-----|---------|
| T6 | Haiku | 5/9 | 9 | A2 "no valid target" after Cheese delivery at Wroclaw |
| T9 | Gemini | 7/9 | 9 | A2 "no valid target" after Tobacco delivery at Ruhr |
| T13 | Gemini | 7/9 | 9 | Moved 2mp toward Torino, then stopped — dead-end track |
| T22 | Gemini | 8/9 | 9 | Moved 1mp toward Napoli, then stopped — dead-end track |
| T33 | Haiku | 5/9 | 9 | A3 prepend move + build, only 4mp used |
| T14 | Gemini | 0 | 9 | success:false "Bot is not at a named city" despite successful delivery |

Total: ~32 mileposts wasted across 5 non-build turns = ~3.5 full turns of lost movement.

## Root Cause Analysis

### Problem 1: A2 "no valid target" after delivery (T6, T9)

JIRA-69 fixed route index advancement and demand cleanup in `splitMoveForOpportunities`. But `findMoveTargets()` (TurnComposer.ts:745) still returns empty when:
- Priority 1 (route stops): All remaining stops are for loads not yet picked up, and the supply city isn't reachable from current position
- Priority 2 (delivery cities): Bot just delivered, so `context.loads` is empty — no deliverable loads
- Priority 3 (supply cities): Demand was cleaned from `context.demands` by JIRA-69 fix, so the next demand's supply city isn't listed
- Priority 4 (reachable cities): Should be fallback, but `context.reachableCities` may not include useful onward targets

The fix should ensure that after delivery, `findMoveTargets` can still find the next route stop's city even if it requires a load pickup first.

### Problem 2: Dead-end track (T13, T22)

The bot's track network has branches that end after 1-2 mileposts. When `resolveMove` pathfinds toward a target, it follows the track but hits a dead-end quickly. The bot should continue building track OR move as far as possible on available track.

### Problem 3: success:false reporting (T14)

`TurnExecutor.executePlan()` returns `success: true` based on `lastResult`, but something sets overall `success: false` with "Bot is not at a named city". This may be in a post-execution check (build eligibility or position validation) rather than the actual turn execution.

## Affected Files

- `src/server/services/ai/TurnComposer.ts:745-807` — `findMoveTargets()` needs better fallback when post-delivery
- `src/server/services/ai/TurnComposer.ts:330-400` — A2 loop should try harder to use remaining movement
- `src/server/services/ai/TurnExecutor.ts:245-261` — `executePlan()` success reporting
- `src/server/services/ai/ActionResolver.ts` — `resolveMove()` dead-end handling

## Impact

32+ wasted mileposts in a 33-turn game = ~3.5 full turns of lost movement. This directly costs 1-2 deliveries over the course of a game.

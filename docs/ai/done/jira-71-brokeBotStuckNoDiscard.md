# JIRA-71: Broke Bot Stuck for 5+ Turns — Hand Quality Ignores Cash, Dead-Hand Discard Too Conservative

## Observed in Game
`668c1ab3-633c-44d4-95c1-7abde035a977` — Haiku bot (`e2e65ac9...6db22d83`)

## Problem

Bot reaches 0M cash at turn 17 but doesn't discard until turn 21 — **5 wasted turns** of DropLoad/MoveTrain with no ability to build track or make progress.

### Bug A: Hand quality score doesn't account for cash

The `computeHandQuality()` function rates the hand based on demand scores but **doesn't factor in whether the bot can afford to execute any delivery**. At turn 17-18 with 0M cash, the hand quality is rated **4.05-4.27 (Good!)** because the demands look profitable on paper — but every single one requires 10-50M of track building the bot can't afford.

Timeline:
| Turn | Cash | Hand Quality | Assessment | Reality |
|------|------|-------------|------------|---------|
| 17 | 0M | 4.05 | Good | Can't afford any route |
| 18 | 0M | 4.27 | Good | Can't afford any route |
| 19 | 0M | 0.21 | Poor | Can't afford any route |
| 20 | 0M | 4.27 | Good | Can't afford any route |
| 21 | 0M | 0.11 | Poor | Finally discards |

The score oscillates because it depends on demand card content, not affordability.

### Bug B: Dead-hand discard trigger too conservative for broke bots

The JIRA-54 dead-hand discard in `heuristicFallback` requires **all demands to be unaffordable AND no on-network delivery**. But the bot has:
- Loads on the train (carried from earlier pickup)
- Some network connectivity (track built in early game)

So the dead-hand check doesn't fire, even though the bot is hopelessly stuck at 0M with no way to reach any delivery city without building more track it can't afford.

The heuristic fallback priority order (deliver > pickup > move > build > pass > discard) means the bot keeps choosing move/build/drop before ever reaching the discard option — but those actions are all futile at 0M.

## Impact

- 5 turns completely wasted (turns 17-21)
- Each turn burns ~3 LLM API calls (all failing) plus heuristic fallback time
- Bot falls further behind opponent who is actively delivering

## Acceptance Criteria

1. `computeHandQuality()` should penalize score when bot cash is too low to afford any demand's `estimatedTrackCostToSupply + estimatedTrackCostToDelivery`
2. Add a cash-aware stuck trigger: if `cash < 5M` and no demand has `estimatedTrackCostToSupply <= cash`, trigger discard regardless of other conditions
3. The broke-bot discard should fire within 1 turn of being stuck at 0M, not 5+
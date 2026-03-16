# JIRA-38: Same-City Multi-Pickup Ignored — Bot Leaves and Returns

**Severity:** High
**Source:** Game `1c8c8f55` analysis (JIRA-37 Bug 1)

## Problem

When the LLM plans multiple pickups at the same city, the route-executor picks up one load, departs the city, then wastes turns returning to pick up the second. The bot should complete all pickups at a city before leaving.

## Evidence — Flash T84-T93 (Iron + Steel at Birmingham)

LLM plan at T84:
> `pickup(Iron@Birmingham) → pickup(Steel@Birmingham) → deliver(Iron@Antwerpen) → deliver(Steel@Budapest)`

The LLM correctly planned to pick up both Iron and Steel at Birmingham — two different loads at the same city, one trip. The Freight train carries 2 loads so this is perfectly valid.

| Turn | What happened |
|------|--------------|
| T90 | Arrives at Birmingham, picks up **Iron only** |
| T91 | **Departs Birmingham** (moved 5mp, wasted 4) |
| T92 | Moves 2mp, wastes 7 — turns around |
| T93 | **Returns to Birmingham**, picks up Steel |

3 turns and ~13 mileposts wasted.

## Evidence — Flash T17-T21 (Ham x2 at Warszawa)

LLM plan at T17:
> `pickup(Ham@Warszawa) → pickup(Ham@Warszawa) → deliver(Ham@Zagreb)`

The LLM correctly planned to pick up two copies of Ham at Warszawa (game rules allow picking up multiple loads of the same type). The bot picked up only one Ham at T17 and moved on. The second pickup was never executed.

## Root Cause

The PlanExecutor processes stops sequentially. After completing stop 0 (first pickup), it advances to stop 1 (second pickup at same city) and issues a `MoveTrain` toward the city it's already standing in. The TurnComposer's A1 opportunity scanner only checks cities along the movement path, not the current city for pending route stops.

## Fix

When PlanExecutor advances to the next stop and the target is the **current city**, execute the pickup/delivery immediately in the same turn without issuing MoveTrain. Alternatively, after any pickup action, check if the next route stop is at the same city and chain it.

## Files

- `src/server/services/ai/TurnComposer.ts` (A1 opportunity scanner)
- `src/server/services/ai/LLMStrategyBrain.ts` (PlanExecutor stop advancement)

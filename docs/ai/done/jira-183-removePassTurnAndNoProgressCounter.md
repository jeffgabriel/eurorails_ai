# JIRA-183: Remove PassTurn and noProgressTurns Counter

**Status:** TODO

## Problem

Bots get permanently stuck in PassTurn loops when broke + on-network route stop + unachievable demand. In game `189a6327-e656-4699-ac7d-bc06ca4a84ff`:

- Nano: $0 cash, 540 consecutive `PassTurn` actions from T72 to T615 with the broke-and-stuck guardrail never firing
- Haiku: 485 `PassTurn` actions T83–T584
- Flash: 291 `PassTurn` actions T100–T426

The broke-and-stuck guardrail (JIRA-177) was introduced to break these loops but fires only when `noProgressTurns >= 2`. `isActivelyTraveling` at `AIStrategyEngine.ts:897` resets `noProgressTurns` to 0 every turn whenever an active route exists and the next stop is on-network — regardless of whether the bot actually moved. The counter therefore never accumulates and the guardrail never fires.

## Root Cause

Two compounding issues:

1. **`isActivelyTraveling` lies.** It returns `true` when a route exists and the next stop is on-network, but doesn't require actual movement. A bot emitting `PassTurn` is counted as "making progress."
2. **The `noProgressTurns` counter adds no value.** Its only consumers are the two guardrails in `GuardrailEnforcer.ts` (stuck ≥3 at line 72, broke-and-stuck ≥2 at line 94). Both guardrail preconditions (`botIsBroke`, `!hasAchievableDemand`, route/load state) are deterministic game state — nothing the bot does next turn changes them except `DiscardHand`. Waiting N turns before forcing a discard is pure latency.

`PassTurn` itself is never a valid strategic bot action. The 540 consecutive PassTurns we saw in Nano's game were the result of the broken counter — the guardrail should have forced DiscardHand long before the bot got stuck in that loop. Fix the counter (step 1 + 2) and the root cause goes away without touching the fallback sites.

Game-forced turn losses (Derailment / lose-1-turn events) are enforced by the game engine and are not part of the bot's decision surface — this ticket does not affect them.

## Proposed Fix

### 1. Delete `noProgressTurns` counter

- Remove `noProgressTurns` from `BotMemoryState` (`src/shared/types/GameTypes.ts:475`)
- Remove all update sites in `AIStrategyEngine.ts` (lines 909, 1226)
- Remove `madeProgress` / `isActivelyTraveling` / `nextStopIsOffNetwork` logic in `AIStrategyEngine.ts:885–905` — no longer consumed
- Remove `noProgressTurns` parameter from `GuardrailEnforcer.checkPlan` (`GuardrailEnforcer.ts:44`)
- Update tests in `BotMemory.test.ts`, `GameSimulator.test.ts`, `GuardrailEnforcer.test.ts`

### 2. Guardrails fire on raw state

**Broke-and-stuck** — fires when:
- `botIsBroke` (cash < 5M)
- `hasActiveRoute`
- `!hasAchievableDemand`
- `planType !== DiscardHand`

No `noProgressTurns` gate. No `consecutiveDiscards` cap. A broke bot with no achievable demand is pulling the slot-machine lever — every discard is pure upside because the cards are already worthless to it. Cap it at 3 and the bot locks into a permanent dead state after 3 unlucky draws. Fire every turn until the bot gets a playable hand.

**Stuck (no route, no loads)** — fires when:
- `!hasActiveRoute`
- `!hasDeliverableLoad`
- `planType !== DiscardHand`

No `noProgressTurns` gate. If the bot has no route and no useful loads, there is nothing to wait for.

### 3. Reject LLM-emitted PASS strings

The LLM prompt already excludes PASS from the action menu (`systemPrompts.ts:28-34`), but `ActionResolver.ts:94-96` still parses `"PASS"` if the LLM hallucinates one from training data:

```ts
case AIActionType.PassTurn:
case 'PASS':
  return ActionResolver.resolvePass();
```

Remove the `'PASS'` string case so any LLM output claiming PASS falls through to the "Unknown action type" error path at line 98. This surfaces the bug loudly rather than silently emitting a PassTurn. `AIActionType.PassTurn` itself stays — internal fallback code still uses it.

**Leave the internal `PassTurn` emission sites alone.** We want visibility when the system produces a PassTurn via a fallback path (zero plans, pipeline error, etc.) — those should appear in the logs as PassTurn so they're debuggable, not silently rewritten to DiscardHand. If those fallbacks fire often, that's a separate bug to investigate on its own terms.

**Do NOT add DISCARD_HAND to the LLM menu.** The deterministic guardrail remains the only trigger for discard — the LLM's job is strategy, not stuck-recovery.

## Risk / Counterargument

The one legitimate reason to keep a grace period: `hasAchievableDemand` might have a false negative, and immediate discard on turn 1 would destroy value. Mitigation: verify `hasAchievableDemand` correctness before removing the counter — add logging to confirm it matches ground truth on the 540-turn Nano case.

A broke bot that keeps discarding is NOT a risk — the cards it holds are already worthless to it, so discarding costs nothing. Removing the `consecutiveDiscards < 3` cap from broke-and-stuck is the point, not a risk.

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/types/GameTypes.ts` | Remove `noProgressTurns` from `BotMemoryState` |
| `src/server/services/ai/BotMemory.ts` | Remove `noProgressTurns` from `defaultState()` |
| `src/server/services/ai/AIStrategyEngine.ts` | Remove `madeProgress` / `isActivelyTraveling` logic (885–905); remove counter updates (909, 1226) |
| `src/server/services/ai/GuardrailEnforcer.ts` | Remove `noProgressTurns` parameter and `>= 2` / `>= 3` gates from both guardrails; remove `consecutiveDiscards < 3` cap from broke-and-stuck |
| `src/server/services/ai/ActionResolver.ts` | Remove `case 'PASS'` at line 95 so LLM-emitted `"PASS"` strings are rejected as unknown actions |
| `src/server/__tests__/BotMemory.test.ts` | Remove `noProgressTurns` assertions |
| `src/server/__tests__/GameSimulator.test.ts` | Remove `noProgressTurns` assertions |
| `src/server/__tests__/ai/GuardrailEnforcer.test.ts` | Update stuck/broke-and-stuck guardrail tests to assert immediate firing |
| `src/server/__tests__/utils/GameSimulator.ts` | Remove `noProgressTurns` metric tracking |

## Acceptance Criteria

- In a replay of game `189a6327-e656-4699-ac7d-bc06ca4a84ff`, Nano's broke-and-stuck guardrail fires on the first turn that meets preconditions (broke + active route + no achievable demand), not after 2+ no-progress turns
- `BotMemoryState` no longer contains `noProgressTurns`
- Existing broke-and-stuck / stuck guardrail tests still pass with the counter removed
- An LLM output of `"action": "PASS"` is rejected by `ActionResolver.resolveAction()` with an "Unknown action type" error, not silently converted to `PassTurn`
- A broke-and-stuck bot that draws unplayable cards discards on every subsequent turn (no cap) until a demand becomes achievable
- System-fallback `PassTurn` emissions (zero plans, pipeline errors) remain as `PassTurn` in logs so they stay visible for future investigation

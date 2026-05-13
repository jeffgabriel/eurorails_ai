# JIRA-39: DropLoad Consumes an Entire Turn

**Severity:** High
**Source:** Game `1c8c8f55` analysis (JIRA-37 Bug 2)

## Problem

When the bot needs to drop a load to free a cargo slot, the DropLoad action consumes the entire turn. Per game rules, dropping a load is free — it does not reduce movement or end the turn. The bot should drop and pickup (and move) all in the same turn.

## Evidence — Flash T46

Plan: `pickup(Ham@Warszawa) → pickup(Flowers@Holland) → deliver(Flowers@Oslo) → deliver(Ham@Paris)`

The bot speculatively picked up Cheese at Holland (T39) en route to Warszawa. At T43 it picked up Ham — train now full (Ham + Cheese, 2/2). It returns to Holland at T46 to pick up Flowers (stop 1), but the train is full.

T46: `action=DropLoad, outputPlan=['DropLoad']` — the **entire turn** is consumed by the drop. No movement, no pickup, nothing else.
T47: Picks up Flowers at Holland.

Without this bug, T46 would have been `[DropLoad, PickupLoad, MoveTrain]` and the Flowers delivery would have happened 1 turn earlier.

## Evidence — Flash T86

Plan: `pickup(Iron@Birmingham) → pickup(Steel@Birmingham) → deliver(Iron@Antwerpen) → deliver(Steel@Budapest)`

At T86, the guardrail drops Beer as undeliverable: `action=DropLoad, outputPlan=['MoveTrain']`. The drop consumed the turn — no actual movement happened (`moved=` empty). The drop blocked movement for that turn.

## Root Cause

When the PlanExecutor detects a full train at a pickup stop, it emits a standalone `DropLoad` plan. The TurnComposer treats DropLoad as a terminal action and doesn't compose further actions (pickup, movement) into the same turn. Per game rules, drop + pickup + movement should all happen in one turn.

## JIRA-42 Impact

JIRA-42 (guardrail overhaul) removes G5 (force-drop undeliverable loads), which was the most common source of forced DropLoad plans. The T86 evidence above (`guardrail drops Beer as undeliverable`) will no longer occur after JIRA-42.

However, this ticket is still needed for cases where the **LLM or PlanExecutor** chooses to drop (e.g., T46 where the train is full and needs to free a slot for a planned pickup). Those drops still need prefix composition.

## Fix

TurnComposer should compose DropLoad as a prefix action, not a terminal one. When a pickup is blocked by a full train, the composition should be `[DropLoad, PickupLoad, MoveTrain, ...]` in a single turn plan.

## Files

- `src/server/services/ai/TurnComposer.ts` (DropLoad composition)
- `src/server/services/ai/LLMStrategyBrain.ts` (PlanExecutor full-train handling)

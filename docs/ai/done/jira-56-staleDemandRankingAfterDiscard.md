# JIRA-56: Stale Demand Ranking After Guardrail DiscardHand

## Bug Description

When the guardrail enforcer overrides a bot's action to `DiscardHand`, the `demandRanking` logged in the NDJSON game log and displayed in the debug overlay reflects the **pre-discard hand**, not the new cards drawn after discarding.

## Evidence

Game `ff240679`, Flash (gemini-3-flash-preview):

- **Turn 10**: Guardrail forces DiscardHand (3 turns stuck). Demand ranking shows Bauxite→Holland, Bauxite→London, Oranges→Ruhr — these cards were discarded.
- **Turn 11**: Guardrail forces DiscardHand again (4 turns stuck). Demand ranking shows Iron→Zurich, Wheat→Manchester, Wheat→Aberdeen — but the resource flyout shows completely different cards because the hand was replaced.

The debug overlay's "Demand Ranking" tab shows cards that no longer exist in the bot's hand.

## Root Cause

In `AIStrategyEngine.ts:424-450`, `demandRanking` is computed from `context.demands` which was built at Stage 2 (line 121) before execution. When guardrail overrides to DiscardHand:

1. Context built with current hand → `context.demands` populated
2. Guardrail overrides action to DiscardHand (line 318)
3. Execution discards hand, draws new cards
4. `demandRanking` computed from ORIGINAL `context.demands` (stale)

The context is never refreshed after DiscardHand execution.

## Affected Files

- `src/server/services/ai/AIStrategyEngine.ts:424-450` — demandRanking computation uses stale context
- `src/client/components/DebugOverlay.ts:275-276` — displays whatever the server sends
- `src/server/services/ai/BotTurnTrigger.ts:185-197` — logs demandRanking from result

## Fix

After DiscardHand execution, rebuild `context.demands` from the new hand before computing `demandRanking`. Alternatively, when `guardrailOverride === true && action === DiscardHand`, set `demandRanking` to an empty array or add a `staleAfterDiscard: true` flag.

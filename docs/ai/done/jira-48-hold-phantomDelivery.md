# JIRA-48: Phantom Delivery — Composition Logs Delivery but Action is DiscardHand

**Severity:** High
**Source:** Game `a5766427` analysis — Flash (gemini-3-flash-preview) T9

## Problem

The composition log records a successful delivery (DELIVER action with payout), but the actual game action is DiscardHand and the payout is never credited to the bot's cash. The delivery appears in the composition/planning layer but never reaches execution.

This is likely a symptom of JIRA-47 (action/outputPlan desync) but worth tracking separately because it masks real progress — the bot's internal state may believe it delivered while the game state says otherwise.

## Evidence — Game `a5766427`, Flash T9

- Composition log shows a DELIVER action with expected payout
- Game action recorded is DiscardHand
- Flash's cash does not increase by the delivery amount
- Subsequent turns show Flash behaving as if the delivery didn't happen (correct) but the logging is misleading for debugging

## Impact

- Makes game log analysis unreliable — deliveries appear in composition but didn't actually happen
- Could cause state drift if any internal tracking relies on composition logs rather than actual game state
- Obscures the true severity of JIRA-47 by making it look like the bot is making progress when it isn't

## Files

- `src/server/services/ai/TurnComposer.ts` (composition logging)
- `src/server/services/ai/TurnExecutor.ts` (execution vs composition state)
- `src/server/services/ai/GameLogger.ts` (logging layer)

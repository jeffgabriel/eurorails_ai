# JIRA-31: LLM Response Log in Debug Overlay

**Date:** 2026-03-04
**Priority:** High
**Related bugs:** Bug 1 (Haiku LLM fails from T8), Bug 6 (Google provider never works), Bug 7 (pickup-drop spiral)

---

## Motivation

Bugs 1, 6, and 7 are all invisible from the debug overlay — we can only see "heuristic-fallback" but not WHY the LLM failed. The raw LLM responses, parse errors, and validation rejections are logged to console but lost in the UI. Adding a per-attempt log to the debug overlay makes LLM failures immediately diagnosable.

---

## Design

Thread an `llmLog` array through the pipeline: `LLMStrategyBrain` collects per-attempt data → `AIStrategyEngine` passes it through `BotTurnResult` → `BotTurnTrigger` emits it in `bot:turn-complete` → `DebugOverlay` renders it.

---

## Data Structure

```typescript
// src/shared/types/GameTypes.ts — new interface near LLMDecisionResult
export interface LlmAttempt {
  attempt: number;          // 1, 2, 3
  responseText: string;     // raw LLM output (truncated to 500 chars)
  error?: string;           // parse error or validation rejection message
  status: 'success' | 'parse_error' | 'validation_error' | 'api_error';
  latencyMs: number;
}
```

---

## Files to Change (5)

| File | Change |
|------|--------|
| `src/shared/types/GameTypes.ts` | Add `LlmAttempt` interface |
| `src/server/services/ai/LLMStrategyBrain.ts` | Collect `LlmAttempt[]` in `planRoute()` retry loop. Push an entry after each `adapter.chat()` call with raw text (truncated), status, error, latency. Return the log alongside the route result (even when returning null). |
| `src/server/services/ai/AIStrategyEngine.ts` | Add `llmLog?: LlmAttempt[]` to `BotTurnResult`. Capture from `planRoute()` result and include in return. |
| `src/server/services/ai/BotTurnTrigger.ts` | Add `llmLog: result.llmLog` to the `bot:turn-complete` socket payload. |
| `src/client/components/DebugOverlay.ts` | Add `llmLog?: LlmAttempt[]` to `BotTurnEntry`. Capture from payload. New `renderLlmLog()` method shows a collapsible "LLM Attempts (N)" section per turn with status badges, latency, truncated response text in monospace, and error messages in red. |

---

## UI Rendering

Each bot turn section gains a collapsible "LLM Attempts" panel:

```
▸ LLM Attempts (3) — 2 failed
  ┌─ #1 [VALIDATION_ERROR] 1200ms
  │  Route infeasible: Cumulative budget exceeded...
  │  ┌ Response: {"route":[{"action":"PICKUP","load":"Wi...
  ├─ #2 [PARSE_ERROR] 800ms
  │  Parsing error: Unexpected token at position 12
  │  ┌ Response: I'll plan a route to deliver Wine to...
  └─ #3 [VALIDATION_ERROR] 950ms
     Route infeasible: No demand card for load type Coal
     ┌ Response: {"route":[{"action":"PICKUP","load":"Co...
```

- Success: green badge
- Parse error: red badge
- Validation error: yellow badge
- API error: red badge

Past turns in the history row show a compact summary: `"3 attempts (2 failed)"`

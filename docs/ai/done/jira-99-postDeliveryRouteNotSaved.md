# JIRA-99: Post-Delivery Re-Eval Route Not Saved to Memory

## Problem

When a route completes mid-turn and Stage 3d successfully plans a replacement route via LLM re-evaluation, the new route is executed (build/move) but NOT saved to memory. The memory save at lines 730-745 unconditionally clears `activeRoute` when `routeWasCompleted = true`, overwriting the replacement route established by Stage 3d.

### Example: Game 9e3d79fa, T8-T9 (player f1eb37b9)

Bot carrying 2 Tourists, executing route: pickup(Tourists@Ruhr) → deliver(Tourists@Torino).

**T8:**
1. PlanExecutor moves to Torino, TurnComposer A1 delivers Tourists → `routeWasCompleted = true`
2. Stage 3d fires (post-delivery re-eval with `routeWasCompleted`):
   - LLM attempt 1: PICKUP Tourists@Torino → Venezia → **validation_error** (Torino doesn't supply Tourists)
   - LLM attempt 2: Same → **validation_error**
   - LLM attempt 3: PICKUP Tourists@Unknown → DELIVER@Venezia → **success**
3. Stage 3d sets `activeRoute = newRoute` (Tourists→Venezia) at line 617, `reEvalHandled = true` at line 618
4. Build phase re-targets toward Venezia, builds 2 segments ($6M) — **route IS being executed**
5. **Memory save (line 730-745)**: `routeWasCompleted` is still `true` → `memoryPatch.activeRoute = null` — **new route overwritten**

**T9:**
- No active route in memory → bot plans fresh (`[route-planned]`)
- LLM attempt 1: PICKUP Tourists@Torino → Venezia → **validation_error** (same hallucination)
- LLM attempt 2: Marble@Firenze → Ruhr → **success** — completely different route
- Bot builds toward Firenze, ignoring the Tourists load it's still carrying and the 2 segments already built toward Venezia
- $6M of track toward Venezia wasted, $19M Tourists delivery lost

### Root Cause

`AIStrategyEngine.ts:730-745`:
```typescript
if (routeWasCompleted || routeWasAbandoned) {
    // ... log route history ...
    memoryPatch.activeRoute = null;  // LINE 745 — unconditional clear
    memoryPatch.turnsOnRoute = 0;
}
```

This block runs when `routeWasCompleted = true` regardless of whether Stage 3d (lines 509-618) successfully established a replacement route. Stage 3d sets `activeRoute = newRoute` (line 617) and `reEvalHandled = true` (line 618), but the memory save ignores both signals.

### Game Rules

No rule is violated — but the bot wastes money on abandoned track and fails to deliver a load it's already carrying, which is strategically terrible.

## Fix

Change line 730 from:
```typescript
if (routeWasCompleted || routeWasAbandoned) {
```
to:
```typescript
if ((routeWasCompleted || routeWasAbandoned) && !reEvalHandled) {
```

When `reEvalHandled = true`, Stage 3d already set `activeRoute = newRoute`. The `else if (activeRoute)` branch at line 747 will correctly save it to memory.

### Secondary Issue: LLM Hallucination

The LLM repeatedly proposes `PICKUP Tourists at Torino/Milano` when the bot already has Tourists on the train. The correct action is `DELIVER Tourists at Venezia` (no pickup needed — the load is already carried). The demand ranking shows `supplyCity: "Unknown"` for Tourists→Venezia, meaning the context doesn't tell the LLM where Tourists can be picked up — so it hallucinates a pickup at the current city. This is a separate issue (context/prompt quality) but exacerbates the bug by burning 2 of 3 LLM attempts.

## Files to Investigate

- `AIStrategyEngine.ts:730-745` — Memory save unconditionally clears activeRoute on routeWasCompleted
- `AIStrategyEngine.ts:617-618` — Stage 3d sets replacement route + reEvalHandled flag (already correct)

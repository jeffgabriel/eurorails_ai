# JIRA-258 — Make turn-log `loadsDelivered` and `actionTimeline` reflect execution outcomes, not plan intent, when an action is rejected (technical)

Companion to `jira-258-turnLogShowsFakeDeliveryOnRejectedAction-behavioral.md`.

## Defect locus

`src/server/services/ai/AIStrategyEngine.ts:883-912` — the post-execution log-assembly loop in `takeTurn`. The loop walks `allSteps` (which is `finalPlan.type === 'MultiAction' ? finalPlan.steps : [finalPlan]`) and pushes every `DeliverLoad` step into `loadsDelivered` and every step into `actionTimeline` (via `buildActionTimeline(allSteps)`). It uses the **plan** as the source of truth, not the per-step execution outcome.

Specifically:

```ts
// line 898-905
if (step.type === AIActionType.DeliverLoad && 'load' in step && 'city' in step) {
  loadsDelivered.push({
    loadType: step.load as string,
    city: step.city as string,
    payment: (step as any).payout ?? 0,
    cardId: (step as any).cardId ?? 0,
  });
}
```

There's no consultation of the `ExecutionResult` (or its new `rejectionReason` field from BE-008). Same problem applies to `buildActionTimeline(allSteps)` at line 915.

## Fix shape

Two viable approaches; recommendation = (B) Annotated, because it preserves auditability ("the plan tried to deliver, but the rejection happened") while keeping `loadsDelivered` honest.

### Option A — Exclude rejected steps

In `TurnExecutor.execute`, attach the per-step `ExecutionResult` (or just its `success` flag + `rejectionReason`) to each step in a parallel array. Pass that array out alongside the final composed plan. In `AIStrategyEngine.takeTurn`, only push to `loadsDelivered` if the corresponding step's execution result has `success: true`. Drop rejected steps from `actionTimeline` entirely.

Pros: simplest log semantics ("if it's in the log, it happened").
Cons: loses the audit trail of "the bot tried X and got rejected" — though `rejectionReason` at the turn level still captures that.

### Option B — Annotate rejected steps (recommended)

Same per-step result plumbing as Option A. In `AIStrategyEngine.takeTurn`:
- For `loadsDelivered`: only push the step if execution succeeded. (No "rejected delivery" entry — `loadsDelivered` should only contain actual deliveries by name.)
- For `actionTimeline`: include the step regardless, but annotate with an `outcome` field: `'executed' | 'rejected'`, plus `rejectionCode` when rejected. This preserves the timeline order ("the bot was at London, tried to deliver Marble, got rejected") for replay/animation purposes.

Type change in `GameLogger.ts:187`:

```ts
loadsDelivered?: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
```

stays as-is.

Type change for `actionTimeline` entries:

```ts
type ActionTimelineEntry =
  | { type: 'move' | 'pickup' | 'build'; /* existing fields */ outcome?: 'executed' | 'rejected'; rejectionCode?: string }
  | { type: 'deliver'; loadType: string; city: string; payment: number; cardId: number; outcome?: 'executed' | 'rejected'; rejectionCode?: string };
```

(The `outcome` field is optional to preserve backward compatibility with existing log entries where every step was assumed executed.)

### Plumbing details

`TurnExecutor.execute` currently returns a single composed `ExecutionResult` for the whole turn. It needs to surface per-step outcomes so the log builder can match them up. Two options:

1. **Inline on the plan**: monkey-patch each step's object with an `_outcome` field after the executor processes it (ugly, mutates plan objects).
2. **Side array**: have `TurnExecutor.execute` return `{ result: ExecutionResult, stepResults: Array<{ index: number, success: boolean, rejectionReason?: { code, message } }> }`. The log builder zips `allSteps` with `stepResults` by index.

Option 2 is cleaner; recommended.

## Acceptance from behavioral

- **AC1** Unit test on the log builder: pass a fixture plan with one `DeliverLoad` step and a `stepResults` array marking that step as `success: false, rejectionReason: { code: 'COASTAL_STRIKE_BLOCKED' }`. Assert: returned log fields have `loadsDelivered` absent/empty.
- **AC2** Unit test, same fixture but `stepResults: [{ index: 0, success: true }]`. Assert: `loadsDelivered = [{ loadType: 'Marble', city: 'London', payment: 31, cardId: 43 }]`. Regression guard.
- **AC3** Unit test on `actionTimeline`: chosen policy (Option B recommended) — assert the rejected step appears in `actionTimeline` with `outcome: 'rejected', rejectionCode: 'COASTAL_STRIKE_BLOCKED'`. If Option A is chosen instead, assert the step is excluded.
- **AC4** Integration: replay Haiku T31 of game `182bfd36-3d3d-46ef-9c1d-0c87373b983f` (or a synthetic snapshot matching it). Assert: turn-log entry's `loadsDelivered` is absent/empty.

## Validation hooks to inspect during fix

- After the fix, grep the NDJSON for entries where `rejectionReason` is set AND `loadsDelivered` is non-empty:
  `jq -c 'select(.rejectionReason and (.loadsDelivered|length // 0) > 0)' logs/game-*.ndjson` should return zero rows for any post-fix game.
- The existing `logRoutes.ts` consumers at lines 476, 502, 671 read `loadsDelivered` for deliveries-per-turn aggregation; after the fix those counts will be accurate.

## Not in scope

- Fixing other plan-vs-outcome divergences for `actionBreakdown`, `compositionTrace.deliveries`, `compositionTrace.pickups`, `milepostsMoved`. If those have the same issue under rejection, file follow-ups — this ticket scopes to `loadsDelivered` and `actionTimeline`.
- Reverting historical NDJSON files. Going-forward only.
- Replacing the "walk plan steps" approach with "consume TurnExecutor's per-action audit log" wholesale. Stays a minimal patch that augments the existing loop with per-step outcomes.

## Relationship to existing JIRAs

- **JIRA-256 / BE-008**: BE-008 added `rejectionReason` to `ExecutionResult` and to per-handler returns inside `TurnExecutor`. That work is intact and correct. This ticket extends the surfacing of those rejections one level up — into the per-step accounting consumed by the log builder in `AIStrategyEngine.takeTurn`.
- **JIRA-257**: the cause of the rejected deliveries surfaced in this game. Fix 257 first if implementing both — it eliminates most occurrences of the symptom. But 258 is an independent log-fidelity fix that should land regardless, so future rejections (from any cause: lost-turn, movement restriction, etc.) also log honestly.

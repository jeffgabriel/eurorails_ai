# JIRA-205 — Technical fix plan

Companion to `jira-205-behavioral.md`.

## Root cause

`gemini-3-flash-preview` is a thinking-capable model. Even when no `thinkingConfig` is sent in the request, the model uses internal reasoning tokens that are drawn from `maxOutputTokens`. The build advisor calls the model with `maxTokens: 2048` and **without** a `thinking` field, so the GoogleAdapter does not inflate the budget for reasoning tokens. The model spends most of the 2048-token budget on internal reasoning and emits 65–70 tokens of visible output before being cut.

The downstream JSON parser sees a partial JSON object, the prose-extraction fallback runs against a half-finished response, and what comes back is a 2-waypoint stub. Each turn the same thing happens.

### Why the existing code path fails

`src/server/services/ai/BuildAdvisor.ts:88-96` — `advise()` calls `brain.providerAdapter.chat`:

```ts
const response = await brain.providerAdapter.chat({
  model: brain.modelName,           // 'gemini-3-flash-preview' for Flash
  maxTokens: 2048,
  temperature: 0,
  systemPrompt: system,
  userPrompt: user,
  outputSchema: BUILD_ADVISOR_SCHEMA,
  timeoutMs: 30000,
});
```

There is **no `thinking` parameter** on this call. In `src/server/services/ai/providers/GoogleAdapter.ts:71-78`, the reserve inflation only fires when `thinking` is truthy:

```ts
let maxOutputTokens = request.maxTokens;
if (this.isGemini3Model(request.model) && request.thinking) {
  const effort = request.effort ?? 'medium';
  const reserve = GEMINI3_THINKING_RESERVE[effort] ?? GEMINI3_THINKING_RESERVE.medium;
  maxOutputTokens += reserve;
}
```

`GEMINI3_THINKING_RESERVE` is `{ low: 2048, medium: 4096, high: 8192 }` (`GoogleAdapter.ts:10-14`). With `thinking` unset, none of that is added — the model is asked to think *and* respond in 2048 total. Gemini 3's defaulted-on reasoning consumes almost all of it. The visible response is whatever fits in the leftover ~70 tokens.

The same bug applies to `BuildAdvisor.retryWithSolvencyFeedback` (`BuildAdvisor.ts:191-199`, also `maxTokens: 2048`, no `thinking`). The two-pass `extractFromProse` fallback (`BuildAdvisor.ts:250-258`) sets `maxTokens: 512` and is intentionally non-thinking — it is fine and not in scope.

### Evidence the cause is reasoning-token consumption (not a structural cap)

- `maxTokens: 2048` is plenty for a corridor of 10–20 waypoints in the structured-output schema. The schema (`src/server/services/ai/schemas.ts:84+`) is a small JSON object with `action`, `target`, an array of `[row, col]` pairs, and a `reasoning` string. Even verbose corridors fit in well under 1000 tokens.
- The observed cap is consistently 65–70 tokens across 10 calls — flat, not size-of-input dependent. That matches "the budget is being eaten somewhere upstream of the visible output," not "the model wanted to say more but couldn't."
- `gemini-3-flash-preview` is a `gemini-3` model, so `isGemini3Model(...)` returns true, but the reserve branch is gated on `request.thinking`, which is undefined.
- For comparison, `LLMStrategyBrain.ts:172` calls `chat({ thinking: { type: 'adaptive' } })` for the trip planner, which *does* trigger the reserve. Trip planner responses in this game are not truncated.

## Fix plan

### Primary fix — pass `thinking` from BuildAdvisor

In `src/server/services/ai/BuildAdvisor.ts`, both call sites of `brain.providerAdapter.chat` (lines 88-96 and 191-199) should pass an adaptive thinking config so the GoogleAdapter inflates `maxOutputTokens` by the reserve. Concretely:

```ts
const response = await brain.providerAdapter.chat({
  model: brain.modelName,
  maxTokens: 2048,
  temperature: 0,
  systemPrompt: system,
  userPrompt: user,
  outputSchema: BUILD_ADVISOR_SCHEMA,
  thinking: { type: 'adaptive' },
  effort: 'low',                       // see note below
  timeoutMs: 30000,
});
```

Two follow-on choices need to be made:

**(a) Effort level.** `low` adds a 2048 reserve; `medium` adds 4096; `high` adds 8192 (`GoogleAdapter.ts:10-14`). The build advisor's task is small (pick a corridor) so `low` should be sufficient and keeps cost down. If `low` still truncates in repro, escalate to `medium`.

**(b) Structured output compatibility.** `GoogleAdapter.ts:86` skips structured output when both `isGemini3Model && request.thinking` are true:

```ts
if (request.outputSchema && !(this.isGemini3Model(request.model) && request.thinking)) {
  generationConfig.responseMimeType = 'application/json';
  generationConfig.responseSchema = ...;
}
```

So enabling `thinking` on Gemini 3 will *disable* the response schema and force the existing prose-extraction fallback (`extractFromProse`, `BuildAdvisor.ts:230-275`) to do the parsing every call. That fallback already exists, runs on the JSON parse-failure path, and works against prose. The change effectively makes the Gemini 3 path always go through it. Two options:

  - **Option 1 (smaller change):** accept that Gemini 3 + thinking → always uses the prose-extraction fallback. Verify in the existing test suite that `extractFromProse` handles the response shape Gemini 3 emits when thinking is on.
  - **Option 2 (cleaner):** call `chat` *without* `thinking` first (preserving structured output), then if `response.text` parses but `waypoints.length < 2` *or* the response was visibly truncated (e.g. `finishReason === 'MAX_TOKENS'` — see below), retry with `thinking: { type: 'adaptive' }`. This keeps the fast path on structured output and only pays the thinking cost on truncation.

Recommend Option 1 for symmetry with `LLMStrategyBrain` (which also passes `thinking: { type: 'adaptive' }` unconditionally) and because the prose-extraction fallback is already proven against the same schema.

### Secondary fix — surface the truncation signal

The Google API returns a `finishReason` per candidate (`GoogleAdapter.ts:159` already reads `candidate?.finishReason`). When the response is truncated by the token cap, that field is `MAX_TOKENS`. Surface it on `ProviderResponse` so callers can detect this case rather than silently consuming a stub.

In `src/shared/types/GameTypes.ts` (or wherever `ProviderResponse` is defined), add an optional `finishReason?: string` field. In `GoogleAdapter.chat`, populate it from `candidate.finishReason`. In `BuildAdvisor.advise`, after the chat call:

```ts
if (response.finishReason === 'MAX_TOKENS') {
  console.warn(`[BuildAdvisor] Response hit MAX_TOKENS — waypoints likely truncated`);
  BuildAdvisor.lastDiagnostics.error = 'response_truncated_max_tokens';
  // Optional: trigger a retry with higher effort or fall through to a deterministic Dijkstra-only build
}
```

This is the diagnostic missing today: the advisor returned a 2-waypoint stub and the resolver had no way to know whether the LLM *meant* "build these 2 segments" or "I was cut off." Logging `MAX_TOKENS` in the advisor diagnostics lets future incidents be detected without log spelunking.

### Tertiary — guard against the 1-segment-when-budget-is-20M case

Even with the truncation fixed, single-segment builds can happen for legitimate reasons (the gap to target really is 1 milepost). What's pathological in the observed game is repeating that across many turns while not reaching the target. In `src/server/services/ai/BuildPhasePlanner.ts` (the layer that consumes the resolver's chosen candidate), when:

1. the chosen build's `cost ≤ 2M` AND
2. the candidate's `reachesTarget === false` AND
3. `remainingBudget ≥ 5M`,

log a warning trace (`build_short_of_target_with_budget`). This isn't a hard guardrail — sometimes you genuinely can only afford a 1-cell extension toward an Alpine — but it gives an observable signal in the composition trace for repeat occurrences.

### What stays the same

- `BuildAdvisor.extractFromProse` (`BuildAdvisor.ts:230-275`) — already correct; will get more traffic under Option 1.
- `BUILD_ADVISOR_SCHEMA` — unchanged.
- `BuildAdvisor.validateWaypoints` and the snap-to-grid pipeline — unchanged.
- `GoogleAdapter.GEMINI3_THINKING_RESERVE` values — unchanged. `low` (2048) is enough headroom given visible-output token usage observed when this advisor *does* succeed in other games.
- The JIT-build deferral gate, BuildRouteResolver, MovementPhasePlanner — none of these are implicated.

## Acceptance criteria

- A bot using `gemini-3-flash-preview` with active route stop `pickup/deliver L@TargetCity` where the network endpoint is ≥ 4 mileposts from `TargetCity` and budget is ≥ 10M, produces a build candidate whose `segmentCount` is consistent with the gap (multi-segment, not 1) on the first try.
- The advisor's `responseText` for this scenario is no longer cut at 65–70 output tokens; full waypoints array is present in the parsed result.
- A new test in `src/server/__tests__/ai/BuildAdvisor.test.ts` reproduces the JIRA-205 scenario: mocked Gemini 3 provider returns a full 8-waypoint corridor only when `thinking` is set on the request, and a 2-waypoint stub when it isn't. After the fix, `BuildAdvisor.advise` returns the 8-waypoint corridor.
- `ProviderResponse.finishReason` is populated by `GoogleAdapter` and exposed in `BuildAdvisor.lastDiagnostics` when present.
- A regression replay of game `d7c3fd78` from T52 onward (or an equivalent unit-level reproduction of the T66 prompt) yields a corridor that connects to Newcastle within 1–2 build turns rather than 8+.
- Existing build-advisor tests still pass.

## Out of scope

- Switching providers or models. The fix should restore correct behaviour on `gemini-3-flash-preview` specifically.
- Re-tuning `GEMINI3_THINKING_RESERVE`. Use existing `low/medium/high` values.
- Fixing the wrong-network-component issue (train at `(12,46)` while building in `(8–13, 29–33)`) — that has its own JIRA.
- Auditing every other LLM call site for the same omission. The observed defect is on the build advisor; symmetric audits are valuable but a separate task.
- Changing the prose-extraction fallback's schema or prompt. It already handles the partial-JSON case; we are just routing more traffic through it under Option 1.

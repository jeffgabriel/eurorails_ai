# JIRA-210 — Technical fix plan

Companion to `jira-210-behavioral.md`.

## Root causes

Two distinct defects in the same ticket. Both ship together because they live in the same prompt-construction path (`systemPrompts.ts` + `PostDeliveryReplanner.ts` + `TripPlanner.ts`) and removing the multi-candidate complexity touches code paths that the stale-state fix also crosses.

### 1. Stale CURRENT PLAN block in post-delivery replan

**Defect location:** `src/server/services/ai/PostDeliveryReplanner.ts:121-124`.

The post-delivery flow:
1. `MovementPhasePlanner.ts:261` advances the route's `currentStopIndex + 1` after a delivery executes (the post-delivery state).
2. `MovementPhasePlanner.ts:264-272` passes the advanced `activeRoute` as a parameter to `PostDeliveryReplanner.replan`.
3. `PostDeliveryReplanner.ts:121-124` builds `replanMemory` for the LLM prompt, copying from `memory` and patching only `deliveryCount`:
   ```ts
   const replanMemory: BotMemoryState = {
     ...memory,                                                        // ← memory.activeRoute is STALE
     deliveryCount: (memory.deliveryCount ?? 0) + deliveriesThisTurn,
   };
   ```
4. `TripPlanner.planTrip` reads `replanMemory.activeRoute` (the un-patched, pre-advance copy) and passes it to `getTripPlanningPrompt`.
5. `systemPrompts.ts:317-331` reads `activeRoute.stops.slice(activeRoute.currentStopIndex)` and renders the stale "remaining stops" — including the just-completed delivery as if it were upcoming.

JIRA-185 patched `deliveryCount` in this exact spot for the same reason (CURRENT STATE block needed the post-delivery count). The same patching needed to be applied to `activeRoute` and was missed. The bug is in code that JIRA-207B added (the CURRENT PLAN block); the upstream cause is the missing memory-sync that predates JIRA-207B but only became visible once JIRA-207B started rendering `activeRoute.stops` to the LLM.

### 2. Multi-candidate prompt structure with no use case

**Defect location:** `src/server/services/ai/prompts/systemPrompts.ts:174-233` (TRIP_PLANNING_SYSTEM_SUFFIX) + the corresponding response-schema consumer in `TripPlanner.ts`.

The prompt asks the LLM to generate `2-3 candidate trips` and emit `chosenIndex` selecting between them. The bot only needs one route per turn. The complexity has accreted:

- **JIRA-194** added `TripPlannerSelectionDiagnostic` to audit when the LLM's `chosenIndex` was overridden.
- **JIRA-206** added the `chosen_not_in_validated → no-route` branch (when LLM picks an invalid candidate, refuse to substitute).
- **JIRA-207B** added the `chosen_invalid_alternative_used` branch (when LLM picks an invalid candidate but a sibling validates, use the sibling) — explicitly amending JIRA-206's ADR-2.
- **JIRA-207B** also added per-candidate `CandidateFailure[]` retry feedback to handle multi-candidate validation failures.

All of this complexity exists to handle failure modes that only arise *because* the LLM is generating multiple candidates and selecting between them. Collapse the prompt to single-route output and the entire chosenIndex/selection-fallback/per-candidate-failure surface goes away.

### 3. Mislabeled NEW OPTIONS section

**Defect location:** `src/server/services/ai/prompts/systemPrompts.ts:357`.

```ts
lines.push(`NEW OPTIONS (${newOptionsCount} card${newOptionsCount !== 1 ? 's' : ''} — evaluate for replanning):`);
```

Two issues:
- `${newOptionsCount}` counts demand-rows after the `isAffordable && !isLoadOnTrain` filter. The filter is applied at `systemPrompts.ts:350-354` to `context.demands`, which is a flat list of supply→delivery rows (each demand card contributes multiple rows — typically 3 — for its alternative supply/delivery pairs). So `newOptionsCount` can be 0–9, not 0–3. Calling them "cards" is wrong.
- The word "NEW" is wrong. A bot's hand is the same 3 demand cards across turns until something is delivered or discarded. They're not "new" — they're just the current options.

### 4. Removable prompt content

The user has identified specific content in `TRIP_PLANNING_SYSTEM_SUFFIX` (`systemPrompts.ts:174-233`) and the persona block (`systemPrompts.ts:138-139`) to delete:

- **Line 175:** `You are planning multi-stop TRIP CANDIDATES. Generate 2-3 candidate trips, then choose the best one.` → remove the multi-candidate framing entirely. Replace with single-route framing.
- **Line 176:** `Each candidate should consider ALL demand cards in NEW OPTIONS simultaneously.` → remove or rephrase as "Your route should consider all OPTIONS simultaneously."
- **Line 200, partial:** Remove the sentence `Start the candidate with a DELIVER stop for any carried load; do NOT emit a PICKUP for it.` Keep the rest of TRIP RULE 1 ("Loads in your CURRENT PLAN ... are already in your possession") since it's just stating a fact.
- **Line 203:** Remove TRIP RULE 4 entirely (`VICTORY ROUTING: Prefer trips through unconnected major cities when payout differences are within 30%.`).
- **Line 207:** Remove TRIP RULE 8 entirely (the `ON-NETWORK DEMAND REQUIRED AS CANDIDATE` rule rewritten in JIRA-207B). Renumber rules 5-7 if a numbered list is preserved.
- **Lines 138-139:** Remove the persona block entirely:
  ```ts
  [BotSkillLevel.Easy]: 'You are a competent player. Think 1-2 turns ahead.',
  [BotSkillLevel.Medium]: 'You are a competent player. Think 2-3 turns ahead.',
  ```
  Verify the consumer (likely `getTripPlanningPrompt` or its caller) still works without it; may need to default the persona to an empty string.
- **Lines 218-233:** Replace the multi-candidate response format:
  ```json
  {
    "candidates": [{ "stops": [...], "reasoning": "..." }],
    "chosenIndex": 0,
    "reasoning": "...",
    "upgradeOnRoute": "..."
  }
  ```
  With single-route response format:
  ```json
  {
    "stops": [...],
    "reasoning": "...",
    "upgradeOnRoute": "..."
  }
  ```

## Fix plan

### Fix 1 — Sync `activeRoute` into `replanMemory` (stale CURRENT PLAN bug)

**Location:** `src/server/services/ai/PostDeliveryReplanner.ts:121-124`.

Replace:
```ts
const replanMemory: BotMemoryState = {
  ...memory,
  deliveryCount: (memory.deliveryCount ?? 0) + deliveriesThisTurn,
};
```

With:
```ts
const postDeliveryRoute = activeRoute.currentStopIndex < activeRoute.stops.length
  ? activeRoute   // route still has remaining stops — show them in CURRENT PLAN
  : null;         // route fully completed — render "(no current plan in flight)"
const replanMemory: BotMemoryState = {
  ...memory,
  deliveryCount: (memory.deliveryCount ?? 0) + deliveriesThisTurn,
  activeRoute: postDeliveryRoute,
};
```

The `activeRoute` parameter is already the post-advance copy (per `MovementPhasePlanner.ts:261`'s `currentStopIndex + 1` and the JSDoc on `PostDeliveryReplanner.replan` line 86). When the just-completed delivery was the route's last stop, the post-advance `currentStopIndex` equals `stops.length`, signaling completion — `postDeliveryRoute = null` lets the CURRENT PLAN block render `(no current plan in flight)` correctly.

### Fix 2 — Collapse multi-candidate to single route

**Locations:**
- `src/server/services/ai/prompts/systemPrompts.ts:174-233` — system prompt rewrite
- `src/server/services/ai/schemas.ts` (or wherever the response schema is defined) — response shape simplification
- `src/server/services/ai/TripPlanner.ts:230-310` — selection logic removal/simplification

**Prompt rewrite (system prompt):**

- Replace `Generate 2-3 candidate trips, then choose the best one.` (line 175) with `Plan one route — the best multi-stop trip for this turn.`
- Remove `Each candidate should consider...` (line 176) or rephrase as "Your route should consider all OPTIONS simultaneously."
- Update WORKED EXAMPLE (lines 186-194) — keep the example, but its preamble should describe a single route, not "the correct candidate."
- Remove TRIP RULE 4 (line 203) entirely.
- Remove TRIP RULE 8 (line 207) entirely.
- Remove the second sentence of TRIP RULE 1 (line 200): "Start the candidate with a DELIVER stop for any carried load; do NOT emit a PICKUP for it."
- Renumber remaining TRIP RULES (1, 2, 3, 5→4, 6→5, 7→6) if numbering is preserved.
- Replace RESPONSE FORMAT (lines 218-233) with the single-route shape (no `candidates[]`, no `chosenIndex`).

**Response schema:**

Define a new schema (e.g., `TRIP_ROUTE_SCHEMA`) replacing the existing multi-candidate one. New shape:
```ts
{
  stops: Array<{ action: 'PICKUP' | 'DELIVER', load: string, supplyCity?: string, deliveryCity?: string, demandCardId?: number, payment?: number }>,
  reasoning: string,
  upgradeOnRoute?: string,
}
```

**`TripPlanner.ts` changes:**
- Response parsing: parse the single-route JSON directly instead of unpacking `candidates[chosenIndex]`.
- Validation: validate the one route's stops; on failure, retry with per-route feedback (no longer per-candidate).
- Selection logic: **delete** the entire `chosen_invalid_alternative_used` / `chosen_zero_stops` / `chosen_not_in_validated` / `llm_rejected_validated` branch at `:258-307`. The new flow is binary: validate the route → use it, or fail → retry / fall back.
- Per-candidate retry feedback: `CandidateFailure[]` collapses to a single `RouteFailure` (or just an error string). The retry prompt fragment becomes "Your previous route failed: {rule}: {detail}" instead of a per-candidate breakdown.

**Diagnostic schema simplification (`LLMTranscriptLogger.ts:28+`):**
- The `fallbackReason` union from JIRA-207A had values: `'chosen_not_in_validated' | 'chosen_zero_stops' | 'no_affordable_candidate' | 'llm_rejected_validated' | 'chosen_invalid_alternative_used' | 'no_actionable_options' | 'keep_current_plan'`.
- After this fix, the chosen-related values become unreachable: `'chosen_not_in_validated'`, `'chosen_zero_stops'`, `'chosen_invalid_alternative_used'`. They can be removed from the union (breaking change for downstream log consumers — game-log mirror, post-game analysis scripts — but those should be tolerant of missing values, not breaking on extra ones).
- `'no_actionable_options'` and `'keep_current_plan'` from R10c stay — those are short-circuit values, not selection values.
- `'llm_rejected_validated'` keeps its meaning but now refers to "the one route the LLM proposed failed validation," not "the LLM's chosen candidate failed."
- `'no_affordable_candidate'` — verify if still used; remove if dead.
- `candidateFailures?: CandidateFailure[]` field can collapse to `routeFailure?: { failedRule: string; detail: string; suggestion?: string }` — or stay as an array with length 0 or 1 for simplicity.

### Fix 3 — Rename and re-count NEW OPTIONS

**Location:** `src/server/services/ai/prompts/systemPrompts.ts:357`.

Replace:
```ts
lines.push(`NEW OPTIONS (${newOptionsCount} card${newOptionsCount !== 1 ? 's' : ''} — evaluate for replanning):`);
```

With:
```ts
const uniqueCardCount = new Set(newOptionCards.map(d => d.cardIndex)).size;
lines.push(`OPTIONS (${newOptionsCount} supply→delivery row${newOptionsCount !== 1 ? 's' : ''} across ${uniqueCardCount} card${uniqueCardCount !== 1 ? 's' : ''}):`);
```

Drop "NEW" and "for replanning" — the bot's hand isn't new, and "for replanning" was tied to the REPLAN framing where this section was meant to be "alternatives to the current plan." Now it's just "what's in your hand that's actionable."

Update all references to "NEW OPTIONS" elsewhere in `systemPrompts.ts` (TRIP RULE 7 at line 206 references it; `getTripPlanningPrompt` user-prompt builder may too; the empty-state line at `systemPrompts.ts:359` says `(no actionable new options this turn)` — drop "new" there too).

### Fix 4 — Remove persona block

**Location:** `src/server/services/ai/prompts/systemPrompts.ts:138-139` and the consuming code path.

Remove:
```ts
[BotSkillLevel.Easy]: 'You are a competent player. Think 1-2 turns ahead.',
[BotSkillLevel.Medium]: 'You are a competent player. Think 2-3 turns ahead.',
```

Find the consumer (likely a per-skill persona block in `getTripPlanningPrompt` or similar). Verify it still produces a valid prompt without the persona — likely just emit an empty string in its place, or delete the variable usage entirely.

## Acceptance criteria

- **AC1** — `PostDeliveryReplanner.replan` patches `activeRoute` into `replanMemory` (in addition to `deliveryCount`). When the post-delivery route's `currentStopIndex >= stops.length`, `replanMemory.activeRoute === null`. Otherwise, `replanMemory.activeRoute === activeRoute` (the parameter, post-advance).
- **AC2** — Unit test reproducing the JIRA-210 game `d87a7577` T6 Haiku scenario: bot at Warszawa, just delivered Steel (carried loads = empty, deliveriesThisTurn = 1, route's currentStopIndex now equals stops.length). When the prompt is rendered, the CURRENT PLAN block contains `(no current plan in flight)`. The substring `DELIVER Steel at Warszawa` does NOT appear.
- **AC3** — Trip-planner response schema accepts `{ stops, reasoning, upgradeOnRoute }` and rejects responses with a top-level `candidates[]` or `chosenIndex` field.
- **AC4** — `TripPlanner.planTrip` parses the single-route response directly. The `chosen_not_in_validated`, `chosen_zero_stops`, and `chosen_invalid_alternative_used` code branches at `:258-307` are removed.
- **AC5** — `TRIP_PLANNING_SYSTEM_SUFFIX` does NOT contain the substrings: `Generate 2-3 candidate trips`, `chosenIndex`, `VICTORY ROUTING`, `ON-NETWORK DEMAND REQUIRED AS CANDIDATE`, `Start the candidate with a DELIVER stop for any carried load`.
- **AC6** — System persona block at `systemPrompts.ts:138-139` is removed; the prompt builder produces a valid prompt without it.
- **AC7** — The OPTIONS section header is `OPTIONS (N supply→delivery rows across M cards):` (or equivalent that does NOT use the words "NEW" or "for replanning"). The empty-state line drops "new" too.
- **AC8** — `TripPlannerSelectionDiagnostic.fallbackReason` union no longer includes `'chosen_not_in_validated'`, `'chosen_zero_stops'`, `'chosen_invalid_alternative_used'`, `'no_affordable_candidate'`. The union retains `'llm_rejected_validated'`, `'no_actionable_options'`, `'keep_current_plan'`. Existing downstream log consumers (game-log mirror, post-game analysis scripts) accept the narrowed union.
- **AC9** — `LLMTranscriptEntry.tripPlannerSelection.candidateFailures` is removed or collapsed to a single `routeFailure?: { failedRule, detail, suggestion? }`. Decide which during implementation; document the choice.
- **AC10** — Existing `TripPlanner.test.ts` tests that asserted multi-candidate selection behavior (chosenIndex honored, chosenIndex out of range, sibling fallback) are removed or rewritten as single-route tests.
- **AC11** — Existing `PostDeliveryReplanner.test.ts` keep-current-plan test is updated to verify `replanMemory.activeRoute` is the post-advance copy (or null when fully completed).
- **AC12** — Running `npm test` passes all suites — `TripPlanner.test.ts`, `PostDeliveryReplanner.test.ts`, `MovementPhasePlanner.test.ts`, `NewRoutePlanner.test.ts`, `LLMTranscriptLogger.test.ts`.
- **AC13** — Game `d87a7577` T6 reproduction unit test verifies the full flow: post-delivery state, prompt rendered, LLM mock returns a single route, `TripPlanner.planTrip` returns that route, `PostDeliveryReplanner.replan` propagates it. The CURRENT PLAN in the rendered prompt is `(no current plan in flight)`, not the stale Steel delivery.

## Out of scope

- Changing the trip-planner LLM model or thinking config (JIRA-205 territory).
- Adding new strategic prompt rules to replace VICTORY ROUTING or the ON-NETWORK requirement. If we want those biases, surface them in scoring (`DemandEngine.scoreDemand`) — separate ticket.
- Auditing other LLM advisors (BuildAdvisor, RouteEnrichmentAdvisor, LLMStrategyBrain.planRoute fallback) for the same multi-candidate or persona issues. This ticket is `TripPlanner` only.
- The `LLMStrategyBrain.planRoute` fallback prompt at `serializeRoutePlanningPrompt` — separate prompt, separate cleanup if needed.
- Re-introducing multi-candidate output if a future use case emerges. We can add it back when there's a real reason; right now it's dead complexity.
- Removing the `WORKED EXAMPLE` block (Cardiff×2-Hops) shipped in JIRA-207B R7 — keep it. The action grammar rules are useful regardless of whether the LLM emits one route or multiple.
- The test files themselves may need broader cleanup if many tests depended on multi-candidate fixtures; doing the bare minimum to keep coverage of single-route behavior is acceptable. Larger test refactors can be a follow-up.

## Product decisions

1. **`candidateFailures` field shape** — array-of-length-1 vs. singular `routeFailure`. Recommend collapsing to singular for clarity; downstream log consumers will need a one-line update either way.

2. **Numbering of TRIP RULES after removals** — keep numbered (1, 2, 3, 4, 5, 6 after renumbering) or convert to bullets? Recommend keep numbered for the LLM's pattern-matching benefit (numbered rules are easier to reference back to in reasoning).

3. **Persona block removal — affect other prompts?** The persona is keyed by `BotSkillLevel`. Other prompts may consume it (build-advisor, route-enrichment-advisor). Verify before deletion; if other consumers rely on it, scope this removal to the trip-planner path only and leave the constants intact for those consumers.

4. **Action grammar rules removal of WORKED EXAMPLE preamble wording** — the example uses phrasing like "two separate PICKUPs ... each for one Hops unit" which is fine, but earlier text says `you are planning multi-stop TRIP CANDIDATES`. Clean this up to "you are planning a multi-stop trip" so the example flows from the new framing.

# JIRA-208 — Technical fix plan

> **Status: HOLD — not being worked.** Captured for the record; no implementation planned at this time.

Companion to `jira-208-behavioral.md`.

## Root causes

Three independent defects collide on game `02be02dc-a624-4ef1-b8ac-6d8d8f53056b`, turn 5, Haiku player. Each can ship independently. They share one trait: the new strict validation introduced by JIRA-207B (commit `c71eab5`) now surfaces failures that older, looser rules tolerated, and the new per-candidate retry loop (`MAX_RETRIES = 2` in both planners → 3 calls each → 6 calls per turn worst case) multiplies the LLM cost of those failures.

Defect 1 is a model-compliance issue specific to Haiku. Defect 2 is a prompt-content issue specific to the strategy-brain user prompt. Defect 3 is an upstream context-construction bug that the new ACTION GRAMMAR + NEW-OPTIONS-membership rules now reject (where they previously may have passed by coincidence).

### 1. Haiku does not honor the "no markdown fences" directive added by JIRA-207B

`src/server/services/ai/prompts/systemPrompts.ts:51` (trip-planner), `:107` (strategy-brain), `:218` (other planner) all end with the line:

> `RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences:`

Commit `c71eab5` added or strengthened this directive as part of "systemPrompts: ... REPLAN framing" (R10/R10a/R10b). Haiku ignores it on 2 of 3 trip-planner calls in the observed trace (callIds `4a27988a` and `7e3ee0ff`) and emits 500–600 words of prose followed by a ` ```json ... ``` ` fenced JSON block.

Downstream the parser does not unconditionally strip prose preamble or markdown fences. `TripPlanner.ts:201-203`:

```ts
parsed = typeof response.text === 'string'
  ? JSON.parse(response.text)
  : response.text as unknown as LLMTripPlanResponse;
```

When `response.text` is `"I need to analyze...\n```json\n{...}\n```"`, raw `JSON.parse` throws, then `ResponseParser.recoverTruncatedJson` is attempted. That recovery path is for truncated valid JSON, not for prose-prefixed fenced JSON, and (per the trace, no `Recovered truncated JSON response` log line for these calls) it does not match. The attempt is recorded as `parse_error` and the retry loop fires.

**Fix options (pick one):**

- **1a (small).** In `TripPlanner.ts:201-203` and the analogous parse step in `LLMStrategyBrain.ts` near `:181`, before `JSON.parse`, run a fence-stripping preprocessor: if the response contains a ` ```json ` fence, extract its body; otherwise if the response begins with non-`{` characters, locate the first `{` and the matching `}` and parse that substring. Treat both as legitimate parse paths, not as parse errors. This converts Haiku's prose-then-fenced-JSON pattern from a 3x retry to a 1x success.

- **1b (firmer prompt).** Move the "no markdown fences" directive from the end of the system prompt to *both* the start and the end, and rewrite it in imperative form (e.g. `Your response MUST begin with the character "{". Do not write any text before the opening brace. Do not wrap the JSON in markdown code fences.`). Combine with 1a as a defense-in-depth measure — the prompt rewrite reduces the rate, the parser fix handles whatever still slips through.

- **1c (model selection).** If 1a + 1b together do not bring Haiku's compliance rate to acceptable levels in a soak run, escalate to the model-tier discussion: Haiku may not be a good fit for these planners and these prompts at all. Out of scope for this ticket beyond flagging.

**Recommended:** 1a + 1b together. 1a alone is a 5-line patch that converts the failure mode from "3 wasted LLM calls" to "1 successful call" for any model that emits fenced JSON. 1b is also small and reduces the rate of Haiku doing this in the first place.

### 2. The strategy-brain `RESOURCE PROXIMITY` block reads as if it lists demand cards

`src/server/services/ai/prompts/ContextSerializer.ts:622-629` appends:

```
RESOURCE PROXIMITY (cheap pickups near your track):
  China available at Leipzig, ~4M from your network (2 hexes)
  Coal available at Wroclaw, ~9M from your network (5 hexes)
```

The intent is informational — "these supply cities are cheap to reach if you happen to have a matching demand." But this block appears at the end of the user prompt, immediately after the dismissive single-line summary `9 other demands need 21-125M track (not viable).` (the path that collapses unviable demands into one line — likely also a JIRA-207B-era addition). With the real demand cards collapsed and the proximity hints listed verbatim, the proximity hints are the most concrete actionable-looking content in the prompt.

All 3 strategy-brain responses on the observed turn invent demand pairs (`PICKUP China Leipzig → DELIVER China Ruhr`, `PICKUP Coal Wroclaw → DELIVER Coal Ruhr`, repeat) where the supply city is drawn from the RESOURCE PROXIMITY block and the delivery city is fabricated as Ruhr because Ruhr is on-network.

**Fix options (pick one):**

- **2a (smallest).** In `ContextSerializer.ts:622-629`, suppress the RESOURCE PROXIMITY block when no demand card in the player's hand actually requires that load type. The block already iterates `context.demands` to compute `resourceProx` — extend the filter to require at least one demand card with `loadType === r.loadType` to keep the entry.

- **2b (rewrite the framing).** Keep the block but reframe each line so the LLM cannot read it as a demand pair. Example: replace `China available at Leipzig, ~4M from your network (2 hexes)` with `(informational only — no demand card matches) China supply at Leipzig is ~4M from your network`. The parenthetical reminder defuses the read-it-as-a-demand failure mode.

- **2c (drop the block entirely).** The block is `JIRA-?` provenance — check git blame for `RESOURCE PROXIMITY` to see what need it was added to address. If that need has since been served by other prompt sections, drop the block.

**Recommended:** 2a. It preserves the block's informational value when there *is* a matching demand card while removing the failure surface when there isn't. 2b is the next-cheapest if 2a is judged to lose too much information.

### 3. Upstream context construction loses the carried-loads list before it reaches the planner prompts

The per-turn game log for turn 5 records `carriedLoads: ["Steel"]` (Steel was picked up at Ruhr on turn 4). The trip-planner prompt's CURRENT STATE block at `systemPrompts.ts:275` renders `- Carried loads: ${context.loads.length > 0 ? context.loads.join(', ') : 'none'}` — and outputs `- Carried loads: none`. The strategy-brain prompt at `ContextSerializer.ts:729` renders `Carried loads: ${snapshot.bot.loads.join(', ') || 'none'}` — and outputs `carrying nothing` (rendered via the Train line, but with the same underlying `snapshot.bot.loads.length === 0` condition).

So both planners are receiving a context where `context.loads` (trip-planner) and `snapshot.bot.loads` (strategy-brain) are empty arrays, while the actual game state has `["Steel"]`.

The render-side code (`systemPrompts.ts:275`, `ContextSerializer.ts:729`) is correct — it reads what it's given. The bug is upstream. `AIStrategyEngine.ts:918` builds the snapshot's carriedLoads from `snapshot.bot.loads`:

```ts
carriedLoads: snapshot.bot.loads.length > 0 ? [...snapshot.bot.loads] : undefined,
```

That is the per-turn-record write path. The planner-context build path is a sibling — somewhere between the turn-trigger entry and the planner invocations, the same `bot.loads` field is being read as empty. Without further investigation it is not clear whether:

- The snapshot the planners receive is stale (built before pickup was applied),
- Or the snapshot is correct but a downstream context-mapping step zeroes out `loads`,
- Or there is a route-state vs. snapshot-state desync where the route-executor's view of carried loads is correct but the planner's view is stale.

This is the upstream defect that weaponises JIRA-207B's stricter rules. The new rules at issue:

- **System prompt's ACTION GRAMMAR rule** (trip-planner system prompt, in `systemPrompts.ts` near the rules block introduced by `c71eab5`): *"DELIVER requires a prior PICKUP in the same candidate's stop sequence, OR the load must already be in your CURRENT PLAN carried loads."* When carried loads renders as `none`, the only valid encoding of `DELIVER Steel @ Praha` requires `PICKUP Steel` first. But Steel's supply city (Ruhr) is not in NEW OPTIONS for this turn (the NEW OPTIONS are 4 fresh demand cards, not card 125), so a PICKUP Steel @ Ruhr stop also violates rule 7.

- **System prompt rule 7** (`systemPrompts.ts` near the planner rules): *"PICKUP and DELIVER stops MUST reference the exact supplyCity or deliveryCity of a demand card listed in NEW OPTIONS."* This rule combined with the empty-carried-loads context makes "keep current plan" mechanically unrepresentable in valid JSON.

Trip-planner Call 3's prose acknowledges the bind explicitly: *"Current plan says: 'DELIVER Steel at Praha (card 125)' but this is invalid — there is NO demand card for Steel delivery to Praha in the NEW OPTIONS. The current plan is broken and cannot be executed."* The LLM is correct given the prompt it received.

**Fix sequence:**

- **3a (investigate first, do not patch blindly).** Add diagnostic logging at the point the planners' context is constructed: log `{ snapshotLoads: snapshot.bot.loads, contextLoads: context.loads, perTurnRecordLoads: <whatever the per-turn record sees> }` with the turn number and player ID. Reproduce `02be02dc` turn 5 in a unit test (or replay) and confirm where the mismatch occurs. The fix surface is one of three places — picking the wrong one will paper over the symptom and leave the underlying desync to bite again later.

- **3b (fix the root cause once located).** Likely either:
  - The snapshot passed to `TripPlanner.planTrip` and `LLMStrategyBrain.planRoute` is built from a pre-pickup state and needs to be rebuilt from the post-pickup state when route-executor has progressed mid-turn, OR
  - The `GameContext` mapping that derives `context.loads` from the snapshot has a code path where it returns `[]` for an in-progress active route (e.g. a "loads not yet committed" state).

- **3c (defense in depth — make the planners robust to the contradiction).** Independent of the upstream fix: when the trip-planner's CURRENT PLAN references a demand card (e.g. card 125) that is not in the NEW OPTIONS list AND not in CURRENT STATE's carried loads, detect that contradiction *before* calling the LLM and treat it as a `keep_current_plan` short-circuit case. The pre-LLM short-circuit at `TripPlanner.ts:139-165` already handles the "no NEW OPTIONS available" case; extend it to also handle "CURRENT PLAN's first remaining stop references a card not present anywhere in the rendered prompt context."

  3c does not fix the underlying state-rendering bug, but it prevents the bot from spending 6 LLM calls and 34 seconds to produce nothing in the meantime.

**Recommended:** 3a → 3b → 3c, in that order. 3c is the cheapest insurance against future variants of the same class of bug.

## Fix sequencing across all three defects

Do not bundle these. Each fix has different blast radius and risk profile.

| Fix | Surface | Risk | Soak metric to confirm |
|---|---|---|---|
| 1a (parser fence-strip) | TripPlanner + LLMStrategyBrain parse step | low | parse_error rate for Haiku drops |
| 1b (prompt rewrite) | systemPrompts.ts (3 directives) | low | parse_error rate drops further across all models |
| 2a (RESOURCE PROXIMITY filter) | ContextSerializer.ts:622-629 | low | strategy-brain validation_error rate for hallucinated supply cities drops |
| 3a (investigation) | logging only | none | reproduces 02be02dc T5 bug locally |
| 3b (root cause fix) | depends on 3a outcome | medium | trip-planner CURRENT STATE matches per-turn record carriedLoads |
| 3c (planner short-circuit) | TripPlanner.ts:139-165 | low | "current plan card not in NEW OPTIONS or carried loads" no longer triggers LLM call |

Recommended ship order: **1a → 2a → 3a → 3c → 1b → 3b.** 1a + 2a + 3c are the three small patches that reduce the cost of failures we know about today. 3a + 3b are the proper investigation of the upstream state desync, which may have other manifestations beyond this single observation.

## What this report does not address

This is a single-observation defect (game `02be02dc` turn 5, Haiku player). The behavioral report explicitly does not generalize beyond this trace. Open questions a soak run should answer before committing to all six fixes:

- Does the carried-loads desync (defect 3) reproduce on other turns or other players, or is it specific to a particular pre-pickup → planner-invocation sequence?
- Is Haiku's prose-then-fenced-JSON rate above the threshold that justifies prompt + parser changes, or is this 1 game in N?
- Do strategy-brain demand-pair hallucinations correlate with the RESOURCE PROXIMITY block being present, or do they happen even when the block is empty?

Defects 1 and 2 are independently shippable and cheap enough that "fix and measure" is reasonable even without a full soak. Defect 3 (especially 3b) warrants the investigation step before any code change.

# JIRA-193: Bot stops after pickup, and Haiku trip-planner retries on every turn

This ticket covers two related bugs surfaced by game `fb3e5856-6311-4c27-a18e-9a7474b43cfd`. They are different root causes but they interact — Bug B (parse errors) causes Bug A (missing `demandCardId`) to fire much more often for Haiku than for the other models.

---

## Bug A — Bot stops immediately after a pickup, leaving movement on the table

### What you'll see in a game

The bot moves to a supply city, picks up its load, and then just stops — even when it still has movement budget and its route says "now deliver at Zurich." The turn looks fine on paper (pickup succeeded, route advanced), but the train is idle for the rest of the turn.

Concrete example from game `fb3e5856`, turn 7, Haiku:

- Start at (37,49) with a freight train (9 mp).
- Moves 5 mp east to Wien, picks up Wine.
- **Stops.** 4 mp unused. The active route still had `deliver(Wine@Zurich)` as the next stop, and the bot's own track already extends west from Wien toward Zurich (built on turn 6).
- A human player would obviously have used those 4 mp to move west toward Zurich.

The trace confirms this was not a planning choice:
- `composition.a2.terminationReason = "route_complete"` (the loop *thought* it was done)
- `composition.a2.iterations = 2` (only two passes: move, then pickup — no third iteration toward Zurich)
- `moveBudget = { total: 9, used: 5, wasted: 0 }` — and the "wasted: 0" is itself part of the bug; 4 mp really were wasted, but the composition trace doesn't notice because the loop terminated cleanly.

### What's actually broken

Inside `TurnExecutorPlanner.ts` the movement loop does this, roughly:

1. Move toward the current stop's city.
2. On arrival, run the stop's action (pickup / deliver / drop).
3. Advance the stop index.
4. Call `skipCompletedStops(route, context)` — a helper that skips any stops that are "already satisfied" according to the current context (loads on train, demand cards in hand).
5. Loop.

For DROP and DELIVER, the code carefully mutates `context.loads` and `snapshot.bot.loads` to remove the dropped/delivered load before calling `skipCompletedStops`. That's correct — without it, the helper would still see the load on the train.

**For PICKUP, the symmetric update is missing.** After a successful pickup the code does not add the new load to `context.loads` or `snapshot.bot.loads`. So from `skipCompletedStops`' point of view, the train is still empty even though the pickup succeeded.

Now here's how that turns into the "stops after pickup" bug:

- The next stop after the Wien pickup is `deliver(Wine@Zurich)`.
- `isDeliveryComplete(stop, context)` in `routeHelpers.ts` declares a delivery complete when two things are both true:
  1. `!loadOnTrain` — the load isn't on the train.
  2. `!demandPresent` — the matching demand card is no longer in the hand.
- Because we never added Wine to `context.loads`, `loadOnTrain` is **false**, so `!loadOnTrain` is true.
- `demandPresent` is computed as `stop.demandCardId != null && demandCardIds.includes(stop.demandCardId)`. The deliver stop from the T6 post-delivery replan had **no `demandCardId`** (the LLM simply didn't emit that field), so `demandPresent` is also **false**, and `!demandPresent` is true.
- Both sides true → `isDeliveryComplete` returns **true** → `skipCompletedStops` advances past Zurich.
- The stop index now equals `stops.length`, the while-loop's guard fails, and the loop exits with `terminationReason = "route_complete"`.

End result: a route with a real unfinished delivery gets mistakenly declared complete mid-turn, immediately after the pickup that was supposed to enable that delivery.

### Why this matters

This is strategically much worse than the JIRA-192 style "lose 1–2 mileposts" bug. Here the bot loses the *entire* continuation move. In the Wien→Zurich case it was 4 mp out of 9 (44% of the turn). And the same pattern applies to any route where a pickup is immediately followed by a deliver stop whose `demandCardId` is missing — which, per Bug B below, is very common for Haiku because of parse-error retries.

It also subtly poisons the next turn: the bot enters T+1 with the same route but at the pickup city, meaning it repeats the "move toward delivery" leg it *should* have started this turn. One wasted turn per such pickup, on average.

### What the fix needs to do

The underlying design problem is that **load-state mutation is inlined in the drop and deliver branches of the movement loop, and missing entirely from the pickup branch.** Adding a third inline block to pickup would fix the immediate symptom but leave the same duplication-and-forgetting hazard for any future action type or any future "what counts as load state" change. The fix should consolidate it instead.

The load state after a stop action executes is a pure function of the action: pickup adds the load, deliver and drop each remove it, anything else is a no-op. That belongs in one place, called once, right after the action is executed — not scattered across three sibling branches.

1. **Structural fix (load-bearing):** Introduce a single helper — either fold the state mutation into `executeStopAction` itself (so "executing" the stop means both generating the plan AND reflecting its effect on local state), or add a sibling helper like `applyStopEffectToLocalState(stop, context, snapshot)` that's called exactly once at the top of the "action succeeded" block (around `TurnExecutorPlanner.ts:288`, after `plans.push(actionResult.plan!)`). The helper covers all action types: pickup adds the load to `context.loads` and `snapshot.bot.loads`; deliver and drop remove it; anything else is a no-op. As part of this change:
   - **Remove** the inline `splice` for drop at `TurnExecutorPlanner.ts:314–317`.
   - **Remove** the inline `splice` for deliver at `TurnExecutorPlanner.ts:330–338`.
   - Leave the rest of the deliver branch intact — the `context.demands` filter, the `resolvedDemands` filter, the JIRA-173 early-execute, the JIRA-165 refresh, the post-delivery replan, and the `deliveriesThisTurn` increment are all deliver-specific logic and should stay where they are.

   The net diff is: one new helper call, three deletions of inline splice pairs, and pickup's "just advance the stop index" branch stays trivially short.

2. **Defensive fix:** Tighten `isDeliveryComplete` in `routeHelpers.ts`. Today, a missing `demandCardId` makes `!demandPresent` default to true, which means "card is gone" — the opposite of what missing data should imply. Flip it: when `demandCardId` is nullish, we have no evidence the card is gone, so the delivery should be treated as **not** complete. This closes the false-positive skip path regardless of whether the load-state helper ever misses an update in the future.

3. **Upstream sanity check:** Investigate why `TripPlanner.ts:313` produced a deliver stop without `demandCardId`. Likely the LLM's response JSON is missing the field for that candidate; `TripPlanner` could fill it in from `context.demands` when `loadType + deliveryCity` matches a single held card, instead of passing `undefined` through. This is belt-and-suspenders alongside the defensive fix.

### Suggested tests

Three layers, matching the three fixes:

1. **Helper-level (structural fix):** Direct tests on the new `applyStopEffectToLocalState` (or whatever the consolidated helper is called). For each action type — pickup, deliver, drop, and an unknown action — assert the correct transformation of `context.loads` and `snapshot.bot.loads`. This is the test that locks in "all stop effects are handled in one place."

2. **Integration-level (pickup regression):** A test on `TurnExecutorPlanner.execute()` with a stubbed route `[pickup(X@A), deliver(X@B)]`, bot starting adjacent to A, 9 mp budget, A+B both on the bot's network, deliver stop with no `demandCardId`. Before the fix: trace shows `terminationReason = "route_complete"` and only a pickup-and-move plan. After the fix: trace continues past the pickup, moves toward B, and terminates with `budget_exhausted` (or reaches B and emits a deliver plan). This is the test that would have caught the Haiku T7 game bug.

3. **Helper-level (defensive fix):** `routeHelpers.isDeliveryComplete` — given a deliver stop with `demandCardId = undefined` and any context, the function should return `false`. Given a deliver stop with a valid `demandCardId` that is present in `context.demands`, it should return `false`. Given a valid `demandCardId` that is absent from `context.demands` and a load not on the train, it should return `true`.

---

## Bug B — Haiku trip-planner fails JSON parse on every attempt, retries 3× per turn

### What you'll see in a game

Haiku turns are slow and noisy. Each turn the TripPlanner calls the model three times (the retry cap), with parse errors logged between attempts. The ndjson HTTP log shows three successful API calls; the server console shows repeated "JSON parse error" warnings.

Evidence from the same game log: each Haiku `trip-planner` response text starts literally with:

```
```json
{
  "candidates": [ ...
```

— i.e., the response is Markdown-fenced JSON, not raw JSON.

### What's actually broken

The recent commit `4753bf8` ("skip output_config and thinking for claude-haiku-* models") changed `AnthropicAdapter.chat` so that for `claude-haiku-*` models it no longer sends `output_config` (which is how we request the JSON-schema-constrained response format for the other models). That change was necessary because Haiku doesn't support `output_config` or `thinking` — the API rejects it — but it has a side-effect: without the schema constraint, Haiku naturally falls back to its default "here is JSON in a markdown block" formatting behavior.

Two downstream consumers do a raw `JSON.parse(response.text)` with no fence-stripping:

- `TripPlanner.ts:151` — throws on fenced JSON, records a `parse_error` attempt, and retries up to `MAX_RETRIES = 2` (3 total attempts).
- `RouteEnrichmentAdvisor.ts:99` — same raw-parse pattern.

The project already has a fence-stripping helper in `ResponseParser.ts` (the `clean` variable step), but these two paths don't route through it, so every Haiku call that returns fenced JSON parse-errors regardless of how well-formed the payload actually is.

The HTTP-level log (`logs/llm-*.ndjson`) records each call as `"status": "success"` because that field reflects the HTTP round-trip, not the downstream parse. That's why the bug is invisible in the ndjson summary but very visible in the server console and in the cost/latency bill.

### Why this matters

- **Latency:** 3 full LLM calls per TripPlanner invocation for Haiku where 1 should suffice. Also doubles the prompt tokens (retries append the previous error to the user message, and the retry bypass cache misses because the user prompt changes).
- **Cost:** Roughly 3× the output token burn, plus every retry runs at full adaptive-thinking settings.
- **Noise:** The server log fills with parse-error warnings that don't actually indicate a bad LLM response — the JSON is valid, just wrapped. This makes real parse errors harder to spot.
- **Quality:** The retry-prompts lean on "PREVIOUS ATTEMPT FAILED: JSON parse error …" to try to coerce Haiku into producing raw JSON. It doesn't reliably work, and the final "success" candidate we keep is often the first one — the retries are burned for nothing.

### What the fix needs to do

Pick one of two approaches (or do both — they're cheap):

1. **Adapter-level strip.** In `AnthropicAdapter.chat` (or the `LoggingProviderAdapter` wrapper), when the response is Haiku and the text starts with a code-fence opener (e.g. `/^```(?:json)?\s*\n/`), strip the opening fence and the trailing closing fence before returning. This centralizes the fix and makes all callers (TripPlanner, RouteEnrichmentAdvisor, BuildAdvisor, StrategyBrain, etc.) transparent to the Haiku behavior. Preference: do this.

2. **Caller-level strip.** Route `TripPlanner.ts:151` and `RouteEnrichmentAdvisor.ts:99` through a shared helper — extract the fence-stripping logic from `ResponseParser.ts` into a small exported utility and use it at every `JSON.parse(response.text)` site. More invasive, but more explicit about "we know the model can emit fences."

A belt-and-suspenders version is: do (1), keep (2) as a safety net so a future refactor to a different adapter doesn't silently regress the behavior.

### Suggested test

A unit test on whichever fence-stripping function we add: given inputs like ``` ```json\n{"a":1}\n``` ```, ``` ```\n{"a":1}\n``` ```, and raw `{"a":1}`, the helper should produce `{"a":1}` for all three. Wire it in, then rerun a single TripPlanner call against a Haiku-style mocked response containing fenced JSON — assert that `llmLog` has one entry and its status is `success`.

---

## Rollout order

I'd take these one at a time rather than bundling them:

1. **Bug B first.** It's a pure correctness/cleanup change, low risk, and it removes noise from the logs while we work on Bug A. It also reduces the rate at which Bug A is exposed (because TripPlanner will less often be forced to rely on retry output, which is where I suspect the missing `demandCardId` comes from).
2. **Bug A second.** The load-bearing context.loads fix is tiny, but the defensive `isDeliveryComplete` tightening plus the `demandCardId` fill-in in `TripPlanner` need a careful test pass because they touch the route-skip logic that every turn runs through.

Both bugs are plausibly "one compounds standard change each" — not worth a large-tier split, but not trivial one-liners either.

## Related work

- **JIRA-104** — count-aware pickup completion; established the pattern that `isStopComplete` should be robust against partial context data. Bug A tightens the same helper.
- **JIRA-173 / JIRA-185** — post-delivery replan state management (loads/demands/money). Bug A is essentially the missing pickup-side twin of those delivery-side patches.
- **JIRA-192** — another "bot wastes movement after pickup" bug, different layer. Bug A is a larger, more severe case of the same family.
- Commit `4753bf8` — the Haiku adapter change that triggered Bug B.

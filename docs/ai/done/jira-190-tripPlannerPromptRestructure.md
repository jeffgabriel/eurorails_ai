# JIRA-190: Restructure the TripPlanner Prompt to Reduce LLM Hallucinations

**Status:** SPEC — awaiting review.
**Parent:** [JIRA-188](./jira-188-nanoCattleLossAndStuckPipeline.md).

## Why

In JIRA-188, the bot lost a load because the trip-planner LLM produced a nonsensical plan (drop cattle at a city where no cattle was on the train) and invented a pickup city that wasn't on any demand card. The plan slipped past validation and got executed.

The proximate failures — validator gap, no recovery from repeated errors — are tracked elsewhere. This ticket addresses the root cause: **the trip-planner prompt is shaped in a way that makes the LLM more likely to hallucinate in the first place.**

## What's wrong with the current prompt

1. **All the turn-specific game state is packed into the system prompt instead of the user prompt.** This is the opposite of how the other LLM callers in this codebase are set up, and the opposite of the Anthropic caching model. Two consequences:
   - Every turn is a full cache miss — we pay full input-token cost on every call.
   - Strategy rules and volatile state compete for the same attention budget. Specific details the LLM needs to get right (like which city supplies a given load) end up buried.

2. **The prompt includes a worked example that shows "drop a load you don't need" as a valid first move in a trip.** The LLM imitates the shape. In our incident, the bot wasn't carrying the load it was told to drop — the model copied the pattern without checking the precondition.

3. **Nothing in the prompt explicitly ties a pickup to a demand card's supply city.** The LLM is shown the supply city for each demand, but when asked to emit a pickup, it sometimes uses the bot's current location instead. A constraint like "pickup cities must match one of the supply cities listed" isn't there — the validator enforces it after the fact, which is why the bad plans get generated, pruned, and then the fallback path picks something worse.

4. **The prompt repeats multi-phase strategic advice every turn.** The LLM gets re-told about the early game, mid game, and late game on every single call — even when the bot's current cash and city count already determine which phase it's in. The advice doesn't travel well when mixed with the specifics of the current turn.

## What we want to change

1. **Separate the system and user prompts properly.** Static rules and response format go in the system prompt (cacheable, stable across turns). Current game state goes in the user prompt (variable, changes every turn). Match the pattern already used by the other LLM callers in this codebase.

2. **Trim the static prompt.** Remove the worked example. Remove "drop" from the trip planner's vocabulary entirely — dropping a load to free capacity is already handled by a separate, dedicated LLM call elsewhere in the pipeline. Collapse the multi-phase strategy text into a single line that depends on the current turn state.

3. **Constrain pickup and delivery cities explicitly.** Tell the LLM, in plain terms, that pickup and delivery cities must come from the demand cards it's been shown. Reinforce the constraint by renaming the schema fields so the model pattern-matches to "the supply city from the card" instead of "some city."

## How we'll know it worked

- The trip-planner system prompt is the same bytes on every call at a given skill level. (Currently, it changes every turn.)
- Over a small sample of games, the rate of hallucinated supply cities in the LLM transcripts drops visibly. Route quality (stops per route, payout per game, deliveries per 100 turns) doesn't regress.
- Prompt-cache hit rate on the trip-planner LLM call goes above zero after the first turn.

## Risks to think about before approving

- Removing "drop" from the trip planner could miss some edge case where the bot legitimately wants to dump a mid-trip load. The separate cargo-conflict LLM call covers this, but we should check its trigger coverage.
- Renaming schema fields changes the shape of what the LLM is asked to produce. Downstream parsers and types will need to line up. The tech spec will enumerate the touchpoints.
- Collapsing the phase-by-phase geographic advice assumes the LLM can infer the phase from cash and city count. If early-game behavior regresses, a single conditional line can be reintroduced.

## Follow-ons (not in scope here)

- Tightening the route validator to reject "pickup X → drop X → deliver X" chains directly (belt-and-suspenders against future prompt mistakes).
- Auditing the other LLM callers in the bot pipeline for the same inverted system/user shape.
- Per-demand-card candidate generation (the change explicitly excluded above) — only if this ticket's changes aren't enough.

## Related

- JIRA-188 — the incident that surfaced this.
- JIRA-189 — the pipeline-error loop from the same game (shelved).
- JIRA-184 — an earlier stuck-loop class; same recovery gap.
- JIRA-185 — a sibling prompt/data-freshness bug in post-delivery replanning.

# JIRA-210 — Trip-planner prompt makes the LLM evaluate 2-3 candidate routes when it only needs to pick one, drowning in invented "trip rules" and rendering a stale CURRENT PLAN that contradicts the carried-loads state in the same prompt

The trip-planner is asking the LLM to do strategic decision-making against a contradictory state snapshot — and demanding that decision come back as a multi-candidate selection problem when the bot only needs one route. The prompt structure adds complexity (and bugs) that the bot's actual job does not require. On top of that, the post-delivery state-sync path is broken: when the bot delivers a load and the planner is called for a fresh route, the prompt simultaneously tells the LLM the bot's train is empty AND that the bot's "current plan" is to deliver the load it just delivered. The LLM correctly reads what it's given, "decides" to keep the plan, and proposes to redeliver a load the bot no longer has.

We never wanted the multi-candidate behavior. The bot picks one route per turn. Asking the LLM to generate 2-3 candidates and then choose between them is unnecessary complexity that adds failure modes, eats tokens, and produces the cascade of validation failures we've been triaging in JIRA-207, JIRA-208, and now this ticket.

## Game evidence — stale CURRENT PLAN: game `d87a7577-cf49-4765-bb32-a2b5a00e1477`

Player: **Haiku**, turn 6.

What actually happened in the game:
- T5: Haiku moves to Warszawa carrying Steel.
- T6 start: Haiku is at Warszawa with Steel on the train. The delivery executes — Steel is delivered for 19M. Bot's train is now empty, deliveries-completed advances from 0 to 1, cash advances from 22M to 41M.
- T6 (still): the post-delivery replanner runs the trip-planner LLM call to figure out what to do next.

What the LLM was sent in the trip-planner prompt at T6 (12:24:25):

```
CURRENT STATE:
- Position: at Warszawa
- Cash: 41M ECU
- Train: freight (speed 9, capacity 2)
- Carried loads: none           ← post-delivery (correct)
- Turn: 6
- Deliveries completed: 1       ← post-delivery (correct)

CURRENT PLAN:
  Remaining stops:
  1. DELIVER Steel at Warszawa (card 90) → 19M    ← STALE: Steel was JUST delivered
```

Three pieces of state in the same prompt say "delivery is done": carried loads is empty, deliveries-completed is 1, position is the delivery city. One piece of state — the CURRENT PLAN's "remaining stops" — is the pre-delivery view, still showing the just-completed deliver-Steel stop as if it were upcoming work.

The LLM correctly read what it was told and walked through the comparison: "current plan delivers 19M immediately at zero cost, all NEW OPTIONS show negative or near-zero efficiency, keep the current plan." It returned a candidate that re-emits `DELIVER Steel at Warszawa` — a stop that cannot actually be executed because the bot doesn't have Steel anymore. The chosen route is meaningless. A second trip-planner attempt seven seconds later was sent the same stale state and produced the same stale answer.

The bot eventually moved on (a downstream code path produced a fresh `pickup Iron@Kaliningrad` route by T6's action emission) but two LLM calls and 14 seconds of latency were burned producing decisions that referenced state that no longer existed.

## What we want the trip-planner prompt to actually be

The bot picks **one** route per turn. The LLM's job is to propose **that one route**, not to generate a slate of alternatives and rank them. Removing the multi-candidate ceremony eliminates an entire class of bugs (chosenIndex out-of-range, sibling-validates-but-chosen-doesn't, candidate-zero-stops-after-pruning) that have shipped under JIRA-194, JIRA-206, and JIRA-207B's selection-fallback work — none of which would exist if the prompt weren't asking for multi-candidate output in the first place.

Beyond the multi-candidate removal, the prompt is loaded with rules that aren't useful and one piece of state-rendering noise:

1. **"Generate 2-3 candidate trips, then choose the best one."** Remove. The bot doesn't need alternatives — it needs one route. Remove the `candidates[]` array and `chosenIndex` from the response schema. The response becomes `{ stops, reasoning, upgradeOnRoute }`.

2. **TRIP RULE 4: "VICTORY ROUTING: Prefer trips through unconnected major cities when payout differences are within 30%."** Remove. Victory routing is a strategic concern but instructing the LLM to apply a 30% threshold for picking unconnected major cities mid-trip is an invented heuristic that's not load-bearing — the bot's victory math should be in scoring/ranking, not in a prompt rule the LLM is asked to apply.

3. **TRIP RULE 8: "ON-NETWORK DEMAND REQUIRED AS CANDIDATE..."** Remove the entire rule. We just rewrote this in JIRA-207B (R9) to clarify that it was about "which demands to propose as candidates, not what stops the candidate contains." With multi-candidate output gone, "you must propose this as a candidate" is meaningless. The LLM picks one route; that's the only proposal. If we want to bias toward on-network demands we can do it in scoring or via a different prompt construct — but the existing rule is now dead weight.

4. **TRIP RULE 1 sub-clause: "Start the candidate with a DELIVER stop for any carried load; do NOT emit a PICKUP for it."** Remove this sentence. With multi-candidate gone, the rule reduces to "your route starts by delivering carried loads" — but that's a tautology if the prompt's CURRENT PLAN block is correct (the LLM sees what's carried; it'll deliver it). Keep the carried-loads context in CURRENT PLAN; drop the prescriptive instruction.

5. **System persona: "You are a competent player. Think 1-2 turns ahead."** Remove. Stylistic preamble that doesn't affect output quality, eats tokens, and reads as cargo-cult prompt engineering. The same applies to the medium-skill variant ("Think 2-3 turns ahead.").

6. **"NEW OPTIONS (5 cards — evaluate for replanning):"** Mislabeled. Two problems:
   - "NEW" is wrong. A bot's hand is the same 3 demand cards turn after turn until something is delivered or discarded. They're not "new" — they're just the current options. Anyone reading the prompt thinks the LLM is being shown freshly-drawn cards every turn.
   - The count (e.g., "5 cards") is wrong. A player only ever holds 3 demand cards at a time. The "5" comes from the prompt-builder counting individual supply→delivery rows — each card has multiple supply/delivery alternatives, and the renderer walks all of them after filtering. So "5 cards" actually means "5 demand-rows after the affordable + non-carry-load filter," which can be anywhere from 0 to 9. Calling them "cards" is a category error that misleads the LLM about what its hand looks like.

   Rename the section to something like "OPTIONS" (drop "NEW") and either label the count by what it actually is ("5 supply→delivery options across 3 cards") or just drop the count parenthetical entirely.

## Why it matters

JIRA-207B was an 11-task implementation that built selection-fallback, per-candidate retry feedback, and a CandidateFailure schema specifically to handle multi-candidate failure modes. JIRA-208 documents 6-LLM-call-per-turn cascades partly caused by the same multi-candidate complexity. JIRA-194 added the `TripPlannerSelectionDiagnostic` to track which candidate the LLM chose vs. which one was actually used. **None of that complexity has any reason to exist if the LLM is just being asked to pick one route.** Removing the multi-candidate frame collapses the entire chosenIndex/selection-fallback/per-candidate-failure surface back to "did the one route validate? if yes use it, if no retry / discard."

The stale CURRENT PLAN bug is a different concern but lives in the same prompt — both should ship together. Until the post-delivery state-sync is fixed, any prompt rule that depends on accurate CURRENT PLAN content (carried-loads filtering, "deliver carried loads first") will continue to be sabotaged by stale state regardless of how we word the rules.

## Out of scope

- The strategic merit of victory routing or on-network demand prioritization. Those goals are valid; the prompt rules that try to encode them are what's being removed. If we want those biases, surface them in scoring or in a deliberate prompt construct — not as ad-hoc rules.
- Other LLM advisors (BuildAdvisor, RouteEnrichmentAdvisor, LLMStrategyBrain.planRoute fallback). This ticket is `TripPlanner` only.
- Re-introducing multi-candidate output later if a real use case emerges. We can add complexity back when we have a justification — right now it's complexity in search of a problem.
- Auditing whether `LLMStrategyBrain.planRoute` (the fallback inside TripPlanner) needs the same prompt simplification. It probably does, but its prompt lives in `serializeRoutePlanningPrompt` and is structured differently — separate ticket if warranted.

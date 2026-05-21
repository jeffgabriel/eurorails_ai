# JIRA-222 — RouteValidator rejects DELIVER-only route for carried load (behavioral)

## Source

Surfaced 2026-05-10 during a working session. User report: "still getting errors parsing llm response that don't include explicit pickup for a load that we are already carrying. this bug was addressed earlier."

Reference game: `1a10d393-10a1-4216-8155-fa1ec62a690f`, player Haiku, turn 5, route `pickup China @ Leipzig → pickup China @ Leipzig → deliver China @ Wien → deliver China @ Kaliningrad`. After the T5 Wien delivery the bot was carrying one China bound for Kaliningrad and triggered a post-delivery replan.

The earlier fix the user is referencing is JIRA-181 (`024c1e7`, "trip-planner carried-load fix — schema, validator, selector, DROP"), which introduced the validator branch that accepts a DELIVER without a prior PICKUP when the load is already on the train.

## Observed behavior (single observation)

Inside the T5 post-delivery replan, the LLM was called four times before a route was accepted:

| Call | Caller | Response shape | Outcome |
|------|--------|----------------|---------|
| 1 | `trip-planner` | `{ "stops": [ { DELIVER China @ Kaliningrad } ] }` | Rejected — "DELIVER China @ Kaliningrad is infeasible: bot does not carry China and no feasible PICKUP appears earlier in this candidate." |
| 2 | `trip-planner` retry | `{ "stops": [ PICKUP China @ Leipzig, DELIVER China @ Kaliningrad ] }` | Rejected (same gate firing on a different leg) |
| 3 | `trip-planner` retry | `{ "stops": [ PICKUP China @ Leipzig, DELIVER China @ Kaliningrad ] }` | Rejected |
| 4 | `heuristic-fallback` (`LLMStrategyBrain.planRoute`) | `{ "route": [ PICKUP China @ Leipzig, DELIVER China @ Kaliningrad ] }` | Accepted |

Call 1's response was the correct play: the bot was at Wien carrying one China, with demand card 30 (China Leipzig → Kaliningrad, 17M ECU) in hand and Kaliningrad already on-network. A DELIVER-only stop is the right answer per JIRA-181. The validator rejecting it caused three wasted Haiku calls (≈45s of latency, 3× tokens) and steered the LLM into emitting a redundant `PICKUP China @ Leipzig` so it could pass the gate — which contradicts the carried-load contract documented in `TRIP_PLANNING_SYSTEM_SUFFIX` ("Loads in your CURRENT PLAN carried loads section are already in your possession. Do NOT emit a PICKUP for a carried load.").

## Why the rejection is wrong

The retry feedback string sent back into the prompt is:

> `PREVIOUS ATTEMPT FAILED: Your previous route failed: missing_pickup: DELIVER China @ Kaliningrad is infeasible: bot does not carry China and no feasible PICKUP appears earlier in this candidate.`

But the bot **was** carrying China at this moment. The same `userPrompt` block sent to the LLM said:

```
- Carried loads: China
...
CURRENT PLAN:
  Remaining stops:
  1. DELIVER China at Kaliningrad (card 30) → 17M
  Carried load: China (demand card unresolved)
```

The prompt and the validator disagree about whether China is on the train. The prompt's `Carried loads: China` line comes from `context.loads`. The validator's "bot does not carry China" comes from `snapshot.bot.loads`. The two diverged inside the post-delivery replan path on this turn.

The "(demand card unresolved)" suffix on the carried-load line is a second tell: the prompt builder failed to find a `context.demands` row with `loadType === 'China' && isLoadOnTrain === true`, even though card 30 is the obvious match. `isLoadOnTrain` is derived from the same `snapshot.bot.loads` set that the validator is reading. Same staleness, two surface symptoms.

## Expected behavior

When the bot is genuinely carrying a load (per the planner's working state for this turn), the `RouteValidator` carried-load gate must accept a DELIVER stop for that load without requiring a prior PICKUP — exactly as JIRA-181 intended. The user-facing prompt and the validator must agree about what is on the train.

A successful T5 post-delivery replan in this game should look like:

- 1 LLM call (not 4).
- Accepted route: `[ DELIVER China @ Kaliningrad (card 30) ]`.
- No `missing_pickup` retry feedback.
- No fabricated `PICKUP China @ Leipzig`.

## Scope of this ticket

Tight to the single observation above:

- The carried-load gate inside `RouteValidator.validate` must not reject a DELIVER for a load the bot is currently carrying mid-turn.
- The post-delivery demand refresh that feeds `isLoadOnTrain` flags into the next replan's prompt must reflect the same carried-load state the validator uses.

**Not in scope**: other readers of `snapshot.bot.loads` elsewhere in the codebase, or any broader audit of the JIRA-196 / JIRA-197 snapshot/context contract. Those may exist but were not observed misbehaving in this game.

## Out of scope

- Changes to the prompt schema or the LLM's response shape.
- Changes to JIRA-181's gate semantics (DELIVER feasible iff carried OR feasible prior PICKUP). The intent stays; only the data source for "carried" changes.
- Changes to `LLMStrategyBrain.planRoute` (the heuristic-fallback path that succeeded on call 4). It accidentally worked here; it is not the fix.

## Evidence

- `logs/game-1a10d393-10a1-4216-8155-fa1ec62a690f.ndjson` — turn 5 entry, `carriedLoads: ["China"]`, `composition.deliveries: [{load: "China", city: "Wien"}]`, ending `activeRoute = [pickup China Leipzig, deliver China Kaliningrad]` (the call-4 fallback route, with `currentStopIndex: 1`).
- `logs/llm-1a10d393-10a1-4216-8155-fa1ec62a690f.ndjson` — four T5 entries showing the retry chain. Call 2's `userPrompt` carries the literal `PREVIOUS ATTEMPT FAILED: ... missing_pickup: DELIVER China @ Kaliningrad is infeasible: bot does not carry China` feedback string.

## Acceptance

A regression test that reproduces the T5 post-delivery replan state — bot at Wien, snapshot/context loads in the divergent state observed in this game, an LLM response containing only `DELIVER China @ Kaliningrad` — must pass validation on the first call, with no `missing_pickup` rejection emitted.

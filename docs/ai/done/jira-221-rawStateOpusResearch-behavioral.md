# JIRA-221 — Research-mode Opus TripPlanner from raw state (behavioral)

## Source

Surfaced 2026-05-09 during a working session investigating Sonnet's poor in-game performance. Game `03b5e5f2-9c97-48e1-ae95-78f845e0d2de` showed Sonnet timing out 9/20 LLM calls (45%) at avg 67s/call, ending with 35M cash vs Haiku's 148M after 66 turns. The proximate fix landed (adaptive thinking gated to Hard only — see TripPlanner.ts:230-241). The deeper question this ticket captures is the upper bound on LLM-driven trip planning when the helper layer is removed entirely.

## Relationship to JIRA-220

JIRA-220 is pulling in the **opposite** direction for medium skill: the helper output is so good, the LLM call is overhead, so remove the LLM. JIRA-221 (this ticket) is a **research experiment** — keep the LLM, but remove the helper output, and measure whether a strong model can play strictly better when given raw state and full latitude. Both can ship without contradiction:

- JIRA-220 governs production medium-skill play (deterministic, fast, cheap).
- JIRA-221 introduces a new **research-only** skill level for offline measurement.

If JIRA-221 produces clearly better play than the deterministic algorithm, it informs a future production-quality "Hard" skill rebuild. If it ties or loses, it confirms the helper-anchored architecture is correct and the research question is answered.

## Scope

**New skill level: `BotSkillLevel.Research` (Opus only).** Easy / Medium / Hard remain untouched.

- **Easy (Haiku)**: candidate-menu spec, unchanged.
- **Medium (Sonnet)**: per JIRA-220 deterministic when that ships; today's helper-anchored Sonnet otherwise.
- **Hard (Opus)**: legacy `TRIP_PLANNING_SYSTEM_SUFFIX` LLM composition, unchanged.
- **Research (new, Opus)**: this ticket. Not selectable via the production lobby UI by default — gated behind a config flag or a hidden lobby option so production game integrity is unaffected.

This ticket does **not** modify any production trip-planning path. It adds a parallel path used only for the experiment.

## Current behavior

There is no raw-state mode. Every skill level today reaches `TripPlanner.planTrip` with a pre-computed `OPTIONS` block in the user prompt — `scoreCandidates` has already enumerated trip candidates with payout/cost/turn estimates, and the LLM picks among ranked alternatives. The LLM never sees:

- The full geographic adjacency graph (terrain, water crossings, ferries).
- Opponent track ownership at the edge level.
- Any city outside its own demand list.

The LLM's role today is to pick the highest-scoring candidate and (in Medium) optionally `propose` an unlisted trip. The helpers do the spatial reasoning; the LLM rubber-stamps.

## Expected behavior

A new code path, gated on `skillLevel === BotSkillLevel.Research`, replaces the helper-anchored prompt with a raw-state prompt that gives Opus enough context to do the spatial reasoning itself.

When a research-mode bot reaches `TripPlanner.planTrip`:

1. The pre-LLM short-circuits (`no_actionable_options`, `keep_current_plan`, `single_option_shortcircuit`) still fire first. Identical behavior. (Reasoning: those are deterministic correctness gates, not strategy decisions.)
2. The raw-state prompt builder runs:
   - Serializes bot state (position, train, cash, loads, connected major cities, turn number).
   - Lists all 9 demands across the 3 cards verbatim, with their `isLoadOnTrain` flag.
   - BFS-extracts the relevant **map subgraph**: from the bot's position and from each of the 9 demand cities (supply + delivery), expand N hops on the union track + base-graph adjacency, take the union of reachable cities, serialize as a per-city neighbor list with edge cost, terrain, and ownership.
   - Lists ferry connections within the subgraph.
   - Lists each opponent's cities-connected, cash, train type, and position.
3. Opus is invoked with this prompt against a new schema `TRIP_PLAN_SCHEMA_RAW` that adds a `segmentsToBuild: [{from, to}]` field — Opus is now responsible for declaring which track to build, not just which trip to take.
4. The response flows through the **existing** validation pipeline:
   - `RouteValidator.validate` on the stop sequence.
   - `simulateTrip` for movement/build/affordability/feasibility.
   - One retry on failure with the validation error appended.
   - On second failure, fall through to the existing heuristic fallback (`LLMStrategyBrain.planRoute`) — same as today's LLM total-failure path.
5. The downstream pipeline (`scoreCandidates`, affordability, upgrade-label normalization, `RouteEnrichmentAdvisor`, `LlmAttempt` logging) runs unchanged.

The helper layer is reduced to a legality+affordability boundary. The LLM does the trip search, the build planning, and the strategic prioritization itself.

## Empirical question

This ticket is a research experiment. It does not promise an improvement; it promises a measurement. The measurement compares research-mode Opus against a baseline of choice (current Sonnet, deterministic JIRA-220 medium, or current Hard-skill Opus) on identical seeds, recording:

| Metric | What it tells us |
|---|---|
| Win rate vs each baseline | Does removing the helper layer help, hurt, or tie? |
| Avg turns to 7-cities + 250M | Strategic-pace difference (the headline number). |
| Avg deliveries per turn | Tactical efficiency (does Opus find better routes?). |
| `RouteValidator` rejection rate | Does Opus reliably emit legal routes from raw state? |
| `simulateTrip` infeasibility rate | Does Opus correctly account for movement/budget constraints? |
| Per-turn latency | Real production cost if this ever became a skill level. |
| Per-turn $ cost (Opus pricing) | Same. |
| `propose`-class wins (trips not in helper OPTIONS) | Counts how often raw-Opus finds wins the helpers miss. |

Suggested experiment: 10 games each on identical seeds, three configurations:

1. Research-Opus vs current Sonnet
2. Research-Opus vs deterministic-Medium (post-JIRA-220)
3. Research-Opus vs current Hard-Opus

If Research-Opus wins (1) by ≥10% but loses (2), that's evidence the helper layer is over-constraining the LLM but the deterministic pipeline beats the LLM regardless. If Research-Opus wins all three, the helper-anchored architecture is leaving substantial play on the table for top-tier models.

## Why this matters

1. **Architecture validation.** Today's bot architecture is built around the assumption that the LLM benefits from pre-computed OPTIONS. JIRA-220 questions whether the LLM is needed at all for medium-skill. JIRA-221 questions whether the helpers are even needed for top-tier models. The two tickets together produce a clean answer about where the helper layer's value lives.
2. **Research artifact.** Even if Research-Opus loses, the experiment produces a measurement we currently don't have. Today's claim "Opus would play better with more context" is unfalsifiable.
3. **Future skill-level design.** A measurable upper bound on LLM-driven play at this game informs whether to invest in further helper improvements, in better prompt engineering, or in tooling that lets the LLM reason about spatial state more effectively.
4. **Cost/latency profile.** Even if Research-Opus plays better, ~$0.15-0.30/turn × 60-80 turns ≈ $10-20/game is unsuitable for the daily-driver opponent. The experiment confirms or refutes "raw-state Opus is a showcase mode, not a production bot."

## Cost expectations

Per-call estimates (Opus 4.7 pricing, $15/M input, $75/M output):

- Input: rules (~1500 tok) + state (~200 tok) + demands (~400 tok) + map subgraph 50 cities × ~30 tok/city (~1500 tok) + opponents (~200 tok) ≈ **3800 input tokens**
- Output: stops + segmentsToBuild + reasoning ≈ **1000 output tokens**
- Per call: 3800 × $15/M + 1000 × $75/M ≈ **$0.13/call**
- Per game (60 turns × ~1 call/turn after short-circuits): **~$8/game**
- A 10-game experiment is **~$80**, all-in.

Latency expected at 30-60s/call. Configure `timeoutMs: 180000` to give Opus headroom. A 60-turn game runs ~30-60 minutes wall-clock when both players are research-mode; ~half that when only one is.

## Out of scope for this ticket

- Modifying any production skill level's behavior (Easy/Medium/Hard untouched).
- Image-based ("screenshot") input. Opus accepts images, but the analysis (this session, 2026-05-09) concluded text serialization of the subgraph is more accurate at lower token cost. If image input becomes interesting later, it's a separate ticket.
- Multi-turn lookahead. Opus produces one trip plan per call, same as today.
- Tuning Opus-specific prompt-cache strategy. The first ~1500 tokens (rules) are a good prompt-cache candidate; ticket leaves this as a small follow-up if cost becomes a measurement obstacle.
- Productionizing Research mode for the lobby UI. The flag is engineering-only by default.
- Changing the `RouteEnrichmentAdvisor` post-processing. It still runs after the Opus plan is produced.
- Replacing or modifying the existing JIRA-220 deterministic medium-skill path.
- Removing or modifying the existing Hard-skill (Opus) helper-anchored path.

## Open questions for review

1. **Skill-level vs flag.** Add `BotSkillLevel.Research` as a new enum value, or gate on a hidden boolean (e.g., `BotConfig.researchMode`) that overrides the skill-level path inside `TripPlanner.planTrip`? Enum is cleaner; flag avoids touching `BotConfig` UI.
2. **Subgraph hop radius.** N=4-6 hops from the bot + each demand city covers most reasoning needs. Higher N produces more accurate spatial context at higher token cost. Ticket suggests starting at N=5 and tuning down if rejection rate is acceptable.
3. **Baseline for the head-to-head.** Pick one or run all three? Cost: 10 games × 60 turns × $0.13 × 2 bots ≈ $156 per pairing for the Opus side alone. If budget is the constraint, the Sonnet baseline is cheapest to compare against.
4. **Whether to build at all.** This is a research project. If the answer to "would this teach us something we don't already know" is no, the ticket should be closed. The behavioral file is intentionally written so review can answer that question without reading the technical file.

## Decisions (pending review)

- [ ] Approve research scope, build behind engineering flag.
- [ ] Approve research scope, build behind new `BotSkillLevel.Research` enum.
- [ ] Reject — close ticket, no implementation.
- [ ] Defer — revisit after JIRA-220 ships and we have deterministic baseline numbers.

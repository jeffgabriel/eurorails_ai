# JIRA-208 — Haiku produces 6 LLM responses on a single turn that are all rejected (3 trip-planner + 3 strategy-brain), so the bot falls through to the route-executor; the prompt rewrites and per-candidate retry mechanism shipped in JIRA-207B both contribute, plus an upstream carried-loads state-rendering bug forces the LLM into a contradiction it cannot encode as valid JSON

> **Status: HOLD — not being worked.** Captured for the record; no implementation planned at this time.

A Haiku-driven bot that was mid-route (carrying Steel, one stop from delivery at Praha) was sent through the trip planner and then the strategy brain on the same turn, generated 6 LLM responses across the two planners, and had every single response rejected — partly as parse failures (response wrapped in markdown fences with prose preamble despite a prompt directive forbidding both), partly as validation failures (response references demand pairs that don't exist in the player's hand), and partly because the planners' new strict rules cannot represent the "keep current plan" path when the prompt's own state section claims the bot is carrying nothing while the bot is in fact carrying the load referenced by the current plan.

The bot still completed its delivery — the route-executor short-circuit caught the fallthrough and executed the pre-existing plan — but the turn consumed 34.5 seconds of LLM latency, ~12k tokens, and 6 model calls to produce zero LLM-driven decision.

## Game evidence — `02be02dc-a624-4ef1-b8ac-6d8d8f53056b`

Player: **Haiku** (`claude-haiku-4-5-20251001`), turn 5.

Authoritative bot state at the start of T5 (from the per-turn game log):
- Position: **(29,49)** (one move from Praha)
- `carriedLoads: ["Steel"]`
- Position at end of turn: **Praha (31,53)**
- Final action timeline: `move` (5 hexes) → `deliver Steel @ Praha for 12M, cardId 125`

The Steel was picked up on turn 4 at Ruhr (per the turn-4 game log: `actionTimeline: [{type: "pickup", loadType: "Steel", city: "Ruhr"}, {type: "move", ...}]`, `carriedLoads: ["Steel"]`).

State as rendered in the trip-planner prompt at the start of T5:
- `CURRENT STATE`:
  - Position: at Praha *(also wrong — bot was at (29,49), not yet at Praha)*
  - Cash: 45M ECU
  - Train: freight (speed 9, capacity 2)
  - **Carried loads: none**  ← *contradicts the actual `carriedLoads: ["Steel"]`*
  - Turn: 5
  - Deliveries completed: 1
- `CURRENT PLAN`:
  - 1. DELIVER Steel at Praha (card 125) → 12M
- `NEW OPTIONS` — the prompt lists 4 fresh demand cards drawn from the deck. **Card 125 is not in this list.** Every card is tagged as negative-efficiency:

| Card | Load | Supply → Delivery | Payout | Build cost | Efficiency |
|---|---|---|---|---|---|
| 136 | China | Leipzig → Zurich | 13M | supply ~4M / delivery ~17M | -1.6M/turn |
| 136 | Oil | Beograd → Bremen | 24M | supply ~25M / delivery ~7M | -0.9M/turn |
| 123 | China | Leipzig → Firenze | 22M | supply ~4M / delivery ~35M | -2.8M/turn |
| 31 | Sheep | Glasgow → Ruhr | 22M | supply ~43M / delivery ~0M | -1.9M/turn |

State as rendered in the strategy-brain prompt on the same turn:
- `Train: freight (speed 9, capacity 2, **carrying nothing**)`  ← *same render bug, different sentence form*
- `YOUR DEMANDS: 9 other demands need 21-125M track (not viable).`
- `RESOURCE PROXIMITY (cheap pickups near your track):`
  - `China available at Leipzig, ~4M from your network (2 hexes)`
  - `Coal available at Wroclaw, ~9M from your network (5 hexes)`

## What the LLM produced — six rejected responses

### Trip-planner — three calls, three rejections

**Call 1** (callId `4a27988a`, latency 8.1s) — Wrapped its JSON in a ` ```json ` fenced block preceded by ~500 words of prose analysis. The system prompt explicitly says *"RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences"*. Inside the fence, the chosen candidate is `DELIVER Steel at Praha, demandCardId: 125, payment: 12` — referencing a card not in NEW OPTIONS, violating the system prompt rule *"PICKUP and DELIVER stops MUST reference the exact supplyCity or deliveryCity of a demand card listed in NEW OPTIONS."*

**Call 2** (callId `a97e0344`, latency 3.9s) — Clean JSON, no fences, no prose. Chosen candidate is the same `DELIVER Steel at Praha, demandCardId: 125`. Same NEW-OPTIONS-membership violation. Also violates the new ACTION GRAMMAR rule *"DELIVER requires a prior PICKUP in the same candidate's stop sequence, OR the load must already be in your CURRENT PLAN carried loads"* — the prompt's CURRENT STATE says no loads are carried, so a DELIVER stop with no preceding PICKUP cannot validate.

**Call 3** (callId `7e3ee0ff`, latency 10.7s) — Identified the contradiction explicitly in its prose:
> *"Current plan says: 'DELIVER Steel at Praha (card 125)' but this is invalid — there is NO demand card for Steel delivery to Praha in the NEW OPTIONS. The current plan is broken and cannot be executed."*

It then rejected all four NEW OPTIONS as economically unaffordable, and ended up proposing `Card 31 (Sheep, Glasgow→Ruhr)` as the "least-damaging" option *"because the only way to satisfy the JSON schema is to propose something."* Wrapped the final JSON in ` ```json ` fences after another ~600 words of prose.

### Strategy-brain — three calls, three rejections (all hallucinated demand pairs)

**Call 5** (callId `1b60358f`, latency 5.0s) — Proposed:
```
PICKUP China @ Leipzig → DELIVER China @ Ruhr
```
The actual China demand cards in the player's hand deliver to **Zurich** or **Firenze**, not Ruhr. Haiku picked up Leipzig as the supply city from the `RESOURCE PROXIMITY` hint and invented Ruhr as the delivery city because Ruhr is on-network. There is no demand card matching this pair.

**Call 6** (callId `0a37c923`, latency 2.6s) — Proposed:
```
PICKUP Coal @ Wroclaw → DELIVER Coal @ Ruhr
```
Same hallucination pattern. The only Coal demand in the hand is `Cardiff → Glasgow`. Wroclaw is fabricated as a supply (drawn from the proximity hint), Ruhr is fabricated as a delivery (drawn from on-network status).

**Call 7** (callId `792849cb`, latency 4.2s) — Re-proposed Call 5's `China Leipzig → Ruhr` hallucination, this time with `startingCity: "Ruhr"`. The strategy-brain user prompt explicitly states *"You may ONLY plan deliveries for demands listed above. Do not reference loads or cities not shown here."* All three strategy-brain responses violate this rule.

## Outcome of the turn

The bot's final action breakdown:
- `decisionSource: route-executor`
- `actor: system`
- `actorDetail: route-executor`
- Action: MoveTrain (5 mileposts, ending at Praha) → DeliverLoad (Steel, Praha, 12M, cardId 125)

The route-executor short-circuit detected that both the trip planner and the strategy brain had failed to produce a viable response and fell back to executing the pre-existing route plan. The delivery succeeded. Nothing the LLM produced on this turn influenced what the bot did.

LLM cost of producing nothing this turn:
- Calls: **6** (`callCount: 6` in the turn's `llmSummary`)
- Total latency: **34,528 ms**
- Total tokens: **8,879 input + 3,041 output = 11,920**

## What is actually wrong (three independent things stacked together)

### 1. The new "no markdown fences, ONLY this JSON" directive does not constrain Haiku

Both system prompts (trip-planner and strategy-brain) end with the directive *"RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences"* — added by the JIRA-207B prompt rewrites (commit `c71eab5`). Haiku ignores this on 2 of 3 trip-planner calls (calls 1 and 3) and emits long prose preambles wrapped around ` ```json ` fenced blocks. Haiku-the-model has a strong default disposition to produce reasoning prose alongside structured output, and a single sentence in the system prompt does not override that default.

### 2. The strategy-brain `RESOURCE PROXIMITY` block is being read as if it lists demand cards

The strategy-brain user prompt lists cheap-to-reach pickups in a `RESOURCE PROXIMITY` block at the end of the user prompt. These are intended as *informational* — "these supply cities are cheap to reach if you happen to have a matching demand." Haiku reads them as actionable demand pairs and pairs them with on-network major cities (Ruhr) as delivery destinations. All three strategy-brain responses on this turn invent demand pairs that don't exist in the hand, and all three sourced their supply city from this block.

This may also be related to the strategy-brain user prompt summarising the full hand as `9 other demands need 21-125M track (not viable)` — i.e., none of the actual demand cards are listed individually for the LLM to reason over. With the real demands collapsed into a single dismissive line and the proximity hints listed verbatim, the proximity hints become the most concrete actionable-looking content in the prompt.

### 3. The "keep current plan" path cannot encode itself in valid JSON when the prompt's CURRENT STATE disagrees with the prompt's CURRENT PLAN

The CURRENT STATE section says `Carried loads: none`. The CURRENT PLAN section says `DELIVER Steel at Praha (card 125)`. The NEW OPTIONS section does not include card 125. The system prompt's ACTION GRAMMAR RULES require that any DELIVER stop be preceded by either a carried load (per CURRENT STATE) or a PICKUP earlier in the same candidate. Rule 7 also requires that any PICKUP/DELIVER reference an exact supplyCity/deliveryCity from a demand card in NEW OPTIONS.

Combining these constraints, the LLM cannot produce a candidate that represents "keep the current plan" — every encoding of `DELIVER Steel at Praha` violates at least one rule. Trip-planner Call 3 explicitly identifies this as *"the current plan is broken and cannot be executed"* and proposes a different (unaffordable) card to satisfy the JSON schema.

The actual bot state — Steel is carried, the delivery at Praha is valid, card 125 exists in the hand — is correct. It is the prompt's rendering of that state to the LLM that is inconsistent: the per-turn game log records `carriedLoads: ["Steel"]` for this same turn, but both the trip-planner CURRENT STATE block and the strategy-brain `Train: ... carrying nothing` line claim no loads are carried. Whatever upstream context construction the planners receive on this specific turn has lost the carried-loads information.

## Scope of this report

This is a single observation from one game (`02be02dc`, turn 5, Haiku player) on the `compounds/guardrail-updates` branch. The "3x" pattern itself (three calls per planner) is a deliberate part of the per-candidate retry mechanism shipped in JIRA-207B (commit `c71eab5`, "TripPlanner: per-candidate validation retry feedback replaces single-line error (R1/R2)") and is not in itself a defect — it is the count of *rejected* responses (6 of 6) that this report documents. Whether the parse-failure and validation-failure rates observed here are representative of Haiku across other turns and other games is not addressed by this single trace.

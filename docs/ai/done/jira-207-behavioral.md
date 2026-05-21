# JIRA-207 — Trip planner LLM misses an obvious same-city double-hop, dismisses a stated build cost as "significant," and the prompt feeds it noise that biases it toward the wrong answer

A bot sitting at a major city it already controls, holding two demand cards that both pick up *the same load type at that same city* and deliver to two different cities (one on-network, one a 6M build away from the network), planned a single-delivery route that left the second 16M payout — plus a new connected major city — on the table. The trip planner LLM saw a candidate that combined both deliveries but produced it without the required `PICKUP` actions, the validator rejected it, the retry feedback was generic, and the LLM defended away the candidate by "reasoning" that the build cost was *significant* — directly contradicting the prompt that had already told it the build cost was 6M.

The same prompt was simultaneously asking the LLM to evaluate demands that were tagged `[UNAFFORDABLE]` (it cannot act on them this turn) and was advertising `UPGRADE AVAILABLE` despite the bot being in the early game with low cash, so the LLM was being invited to consider upgrading instead of doing the strategically obvious thing.

## Game evidence — `5302ee21-9848-4ec2-bd2d-95b399a238e4`

Player: **Nano** (gpt-5.4-nano), turn 9.

State at the start of T9 (from the trip-planner prompt):
- Position: **at Cardiff** (on-network)
- Cash: **37M ECU**
- Train: **freight (capacity 2)**, no carried loads
- Connected major cities (2/8): **Holland, Berlin** — Ruhr listed as "~6M to connect"
- Deliveries completed: **2**

Three demand cards in hand, with a Cardiff supply pair that should have been impossible to miss:

| Card | Load | Supply → Delivery | Payout | Build cost (supply / delivery) | Tag |
|---|---|---|---|---|---|
| 7 | Hops | Cardiff → **Ruhr** | 16M | ~0M / **~6M** | (no on-network tag) |
| 10 | Hops | Cardiff → **Holland** | 16M | ~0M / ~0M | **[ON-NETWORK]** |
| 80 | Potatoes | Szczecin → Wien | 9M | ~0M / ~18M | (no on-network) |

The obvious play, available *immediately* from current position with no movement to set up:

1. Pickup Hops at Cardiff (load 1 of 2)
2. Pickup Hops at Cardiff (load 2 of 2)
3. Deliver Hops to Holland (free, on-network) → +16M, demand card 10 cleared
4. Build 6M of track to Ruhr
5. Deliver Hops to Ruhr → +16M, demand card 7 cleared, **Ruhr added to connected major cities (2/8 → 3/8)**

Net: **26M cash gain in one trip + a new major-city connection**. Compared to the alternative the bot actually picked: 16M gain, no new connection.

## What the LLM produced

**First call** — three candidates returned. Candidate 0 (chosen): just the on-network Holland delivery. Candidate 2 *did* try to combine both Hops deliveries:

```json
"stops": [
  {"action": "DELIVER", "load": "Hops (Card 7)", "deliveryCity": "Ruhr"},
  {"action": "DELIVER", "load": "Hops (Card 10)", "deliveryCity": "Holland"}
]
```

— but it has no `PICKUP` actions. The bot's carried-loads list is empty; the validator rejects this candidate. The LLM's own reasoning for it dismisses the play: *"Card 7 to Ruhr likely requires paying a significant delivery build cost (Ruhr is unconnected), reducing net value versus the pure on-network Card 10 delivery."* The prompt explicitly stated `delivery ~6M`. The LLM substituted "significant" for the actual number it was given, then used that substitution to talk itself out of the trip.

**Second call** — same prompt with one extra line: `PREVIOUS ATTEMPT FAILED: All candidates failed validation`. The LLM reacted defensively:

- Re-issued the single Holland delivery as candidate 0.
- Built two *new* multi-stop attempts using Card 80 (Potatoes Szczecin → Wien) — neither was the obvious double-hop the validator just rejected. Both new attempts also missed pickups and the LLM rationalized them away with the same "this is probably invalid" voice.
- The Cardiff×2-Hops-deliver-both-Holland-and-Ruhr corridor never reappeared in any candidate set.

The chosen action: pickup 1 Hops at Cardiff, deliver to Holland, +16M. Ruhr stayed unconnected. Card 7 stayed in hand.

## Why the LLM missed it

Four issues stack in this single turn:

**1. The LLM doesn't write `PICKUP` actions for multi-load same-city plays.** Cardiff has two Hops loads available; the bot has capacity 2 and is *physically standing at Cardiff*. The natural action sequence is "pickup, pickup, move, deliver, build, deliver." Every multi-stop candidate the LLM generated for the double-Hops play omitted both pickups and went straight to two `DELIVER` actions. Validation correctly rejects this — but the LLM doesn't learn from the rejection, it abandons the candidate.

**2. The LLM disregards stated build costs.** The prompt provides `Build cost: supply ~0M, delivery ~6M` as a structured numeric value. The LLM's natural-language reasoning replaces this with qualitative judgment ("significant") and then weighs the qualitative judgment against the cash payout instead of the actual number it was told. 6M of build to unlock 16M payout *and* a new connected major city is one of the most attractive ROIs a bot can find; calling it "significant" and walking away is the wrong read.

**3. The retry feedback teaches nothing.** `PREVIOUS ATTEMPT FAILED: All candidates failed validation` doesn't tell the LLM *which* candidate failed *which* validation rule. The LLM doesn't know "candidate 2 was missing pickups" — it just knows "something I did was wrong" and gets defensive across all multi-stop plays. The candidate that was one missing field away from being correct is dropped instead of fixed.

**4. The prompt invites the LLM to consider plays it cannot or should not make, and adds tags that duplicate information already encoded elsewhere.** Three distinct prompt-noise problems compound on the same turn:

- **Unaffordable cards listed.** The prompt lists every `[UNAFFORDABLE]` demand card alongside the actionable ones — Tobacco from Napoli (60M build), Imports from Antwerpen → Porto (78M build), Oranges from Valencia (72M build), Fish from Aberdeen (44M build). The bot has 37M cash. None of them are actionable this turn. Their presence dilutes the LLM's attention away from the cards that are actually playable. 4 of the 9 listed demands at T9 were `[UNAFFORDABLE]` — almost half the demand section was noise.
- **Upgrade advertised when it shouldn't be taken.** The prompt says `UPGRADE AVAILABLE: You can upgrade your train for 20M` — at turn 9, with only 2 deliveries completed and 37M cash, taking that upgrade would leave the bot with 17M (below the 20M build budget cap, before any per-turn opponent-track fees), making the suggestion strategically wrong even though it is technically affordable. The LLM ended its chosen-route reasoning with `"upgradeOnRoute": "FastFreight"` — it picked up the suggestion.
- **`[FERRY]` tags are redundant with the cost / turn estimates.** The prompt tags Hops Cardiff → Holland as `[FERRY]`, Hops Cardiff → Ruhr as `[FERRY]`, etc. The LLM does not need a tag to know a ferry is involved — the per-card `Build cost`, `Estimated turns`, and `Efficiency` figures already incorporate any ferry crossing in their calculation. The tag is presented as an *extra factor for the LLM to weigh*, encouraging defensive reasoning ("ferry is involved, this might be slow / risky") that's already baked into the numbers it was given. 5 of 9 demand cards at T9 carried the `[FERRY]` tag; the LLM had no way to use this beyond what the structured numbers already told it.

## T10 — same bug class, harder failure: bot discards the very card that would have made the play

The next turn (T10), the LLM produced **three** candidates:

1. **Candidate 0 (chosen):** `DELIVER Hops at Holland` — same missing-PICKUP shape as T9. Reasoning: *"Card 10 ... is explicitly [ON-NETWORK], so it requires no build and is the only fully valid immediate payout from the current network ... while staying compliant with the rule that ON-NETWORK demands must appear as a complete candidate."*
2. **Candidate 1: VALID** — `PICKUP Hops at Cardiff` then `DELIVER Hops at Ruhr (16M)` — exactly the play the bot needed (and the same play candidate 2 of T9 had attempted to bundle). Reasoning was cautious but correct: *"~6M but still affordable given 37M cash."*
3. **Candidate 2:** `PICKUP Potatoes at Szczecin` then `DELIVER Potatoes at Wien` — also viable.

The LLM's chosenIndex was **0**. The validator rejected candidate 0 (missing PICKUP). Even though candidate 1 was valid and would have built the bot 6M of track to Ruhr for a 16M payout AND its 3rd connected major city, the system did NOT fall back to candidate 1. Instead it returned no-route, the heuristic-fallback fired, and the bot's action came back as **`DiscardHand`** — throwing away its hand including Card 7 (the Cardiff → Ruhr Hops card that the viable candidate 1 was built around).

Two distinct bugs collide on T10:

**A. The LLM hallucinated a rule.** It reasoned that ON-NETWORK demands "must appear as a complete candidate" — taking "complete" to mean "without a PICKUP step." The prompt does have language about ON-NETWORK demands needing to appear as candidates, but it does not say (and does not mean) that they don't need pickups. The LLM invented that interpretation and chose its own invalid output as the best one.

**B. The selection logic threw away a viable alternative.** When the LLM's chosenIndex points to a candidate that fails validation, the code-path returns no-route rather than substituting the highest-scoring validated candidate from the same response. So candidate 1 — present, valid, and offering the play we explicitly want the bot to make — was discarded along with the malformed candidate 0. The downstream heuristic then chose DiscardHand, throwing the very card (Card 7, Hops Cardiff → Ruhr) that candidate 1 was about to deliver.

The net result on T10: bot loses Card 7, loses 16M of expected revenue, loses the 6M-to-connect Ruhr connection it had been one valid candidate away from making, **and** burns the only good demand draw in its hand for two free re-rolls. By T11 the bot has no Cardiff-supplied card at all.

## Why it matters

A double-hop from a major city the bot already controls, with one of the two deliveries explicitly tagged `[ON-NETWORK]` and the other listed as costing 6M to enable, is the canonical "free money" pattern in this game. Any human player would jump on it. When the LLM trip planner misses this, the bot loses:

- 16M of immediate cash (Card 7 payout left on the table)
- 12.5% of its city-connection victory progress (Ruhr unclaimed)
- Compounding: Card 7 stays in the hand, blocking a fresh draw that could have been a new high-payout opportunity

The pattern is observed once in this game and this bot, but the four contributing causes are all systemic: same-city pickup composition, stated-cost rationalization, vague retry feedback, and prompt noise. Any of them firing on any turn for any LLM-driven bot will produce the same shape of failure.

## Out of scope

- The double-hop rejection caused by missing pickups — there's a related bug class where the validator rejects a syntactically wrong but strategically correct candidate, but the planner-side fix here is to never produce the wrong syntax in the first place. Validator-side improvements are a separate concern.
- BuildAdvisor truncation behavior on Gemini 3 — that's JIRA-205, separate ticket, separate module.
- Whether the bot's `estimatedTrackCostToDelivery` for Ruhr is accurate. The 6M figure may itself be optimistic for actual mountain/river terrain; if it is, that's a `DemandEngine` cost-estimation bug, separate ticket.
- Multi-bot game-theoretic considerations (e.g., should the bot rush Ruhr to deny it from opponents). The strategic case here is single-bot ROI.

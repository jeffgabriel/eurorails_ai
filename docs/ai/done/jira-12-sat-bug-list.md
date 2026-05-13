# JIRA-12: Saturday Bug List

Bugs observed during live gameplay on 2026-02-28.
- Game 1: `b7017267-6609-47bb-9bcc-80833a06121a` (Bugs 1-10)
- Game 2: `8cb4f8f5-8acf-406d-b99c-4a60a551641b` (Bugs 11-12)

---

## Bug 1: Ferry rules not enforced

**Severity:** Critical (game rule violation)

The bot crosses ferry ports as if they were normal track. No stop at the port, no half-speed on the next turn.

**Example (Turn 17):** Bot moves from milepost near Sassnitz through the Sassnitz-Malmö ferry and continues 7 mileposts past Malmö — all in one turn. A Freight should stop at Sassnitz, then move at half speed (5 mileposts) from Malmö on the next turn.

**Example (Turn 23):** Same violation in reverse. Bot moves from near Stockholm through Malmö-Sassnitz ferry and continues past Sassnitz in one turn.

---

## Bug 2: DropLoad not wired into AI pipeline

**Severity:** Critical (causes deadlock — see Bug 9)

The bot cannot drop loads. `AIActionType.DropLoad` exists in the enum and `TurnExecutor.handleDropLoad()` is fully implemented, but nothing in the pipeline can reach it:
- Not in the `TurnPlan` type union
- No case in `ActionResolver.resolveSingleAction`
- Not mentioned in the LLM system prompt
- TurnComposer never composes it

When the LLM suggests "DropLoad", ActionResolver returns "Unknown action type" and the pipeline falls back to PassTurn.

**Example (Turn 43):** Bot at Göteborg carrying Bauxite (no demand) and Beer (Valencia — unreachable). LLM correctly identifies it should drop a load. Pipeline rejects the action. Bot passes.

---

## Bug 3: Bot picks up loads with no matching demand

**Severity:** High

The bot picks up loads speculatively even when it has no demand card that could use them. It then carries dead-weight loads indefinitely.

**Example (Turn 12):** Bot delivers Bauxite to Holland (consuming card 74). In the same turn, it picks up another Bauxite at Holland — but no remaining card demands Bauxite anywhere. The bot carries this Bauxite for 20+ turns with no way to profit from it.

---

## Bug 4: Bot doesn't pick up multiple loads at the same city

**Severity:** High

When the bot is at a city with multiple pickupable loads matching its demands, it only picks up one and leaves. It sometimes wastes turns going back for the second.

**Example (Turn 7):** Bot is at Budapest with 1/2 load capacity. It picks up Bauxite (for card 74: Bauxite→Holland) but does NOT pick up Tourists (for card 128: Tourists→Stockholm, 33M). Budapest has both. Bot leaves, wastes turn 8 going back to Budapest, and picks up Tourists on turn 9. Two turns wasted.

---

## Bug 5: Bot pursues infeasible deliveries

**Severity:** High

The bot picks up loads and moves toward delivery cities that have no track connection and would cost far more to reach than the delivery pays.

**Example (Turn 36):** Bot picks up Beer at Praha for card 45 (Beer→Valencia, 35M). Valencia is in Spain with zero track connection. Building there would cost 100M+. The bot wanders with Beer for many turns accomplishing nothing.

**Example (Turns 13-14):** Bot builds 34M of track toward Wien and south toward Roma for a 40M delivery (Iron→Roma). Net gain: 6M after 34M+ in construction. Meanwhile it has 45M total cash.

---

## Bug 6: Guardrail deadlock — bot stuck forever with useless loads

**Severity:** Critical (game-blocking)

When the bot carries loads that have no matching demand and no feasible delivery, Guardrail 4 ("no passing while carrying loads") blocks PassTurn. The guardrail override generates a MOVE that fails (bot is already there or target is unreachable). The bot loops forever.

**Example (Turn 43+):** Bot at Göteborg with Bauxite (no demand card) and Beer (Valencia — unreachable). Every turn:
1. LLM says PassTurn
2. Guardrail blocks it: "has loads, can't pass"
3. Guardrail overrides to "MOVE toward Göteborg to pick up Machinery"
4. Bot is already at Göteborg → MOVE fails
5. Bot has 2/2 loads → can't pick up anyway
6. Turn ends with failure. Next turn repeats.

Game is permanently stuck.

---

## Bug 7: Bot doesn't consider discarding its hand

**Severity:** Medium

When all 3 demand cards are infeasible (delivery cities unreachable, supply cities disconnected), the bot never discards its hand to draw new cards. This is often the best play.

**Example (Turn 38+):** Bot's cards are {127, 121, 45}. None have a realistic near-term delivery:
- Card 127: Wheat→Stockholm (no Wheat source on network)
- Card 121: Machinery→Cork (Cork is in Ireland, unreachable)
- Card 45: Beer→Valencia (Spain, unreachable)

Bot should discard all 3 and draw fresh. Instead it wanders aimlessly.

---

## Bug 8: Wasted movement — bot reverses direction for no reason

**Severity:** Medium

The bot sometimes moves toward a destination, then reverses back the way it came on the next turn.

**Example (Turns 36-37):** Bot at Praha picks up Beer, moves to (48,26) toward Ruhr/Holland area. Next turn, moves back to Praha. No pickup, no delivery, no build. Two turns of movement cancelled out.

---

## Bug 9: Build-only turns while carrying deliverable loads

**Severity:** Medium

The bot spends turns building track instead of moving to deliver loads it's already carrying.

**Example (Turns 20-21):** Bot is at Stockholm carrying Bauxite and Iron. Spends two turns building track near Roma (36M total) instead of moving. The loads sit idle while cash is spent on construction that could have waited.

---

## Bug 10: Premature expensive construction

**Severity:** Low (strategic, not mechanical)

The bot builds expensive track corridors in the early game when cash is scarce and simpler deliveries are available.

**Example (Turns 13-14):** At 45M cash, bot spends 34M building toward Wien and south. Wien is needed for 7-city victory but that's 200M+ away. The cash would be better spent on short delivery runs to accumulate capital.

---

## Bug 11: UNAFFORDABLE gate kills all early-game deliveries

**Severity:** Critical (causes Bug 12 — bot stuck doing nothing)

The demand scoring flags any delivery where track cost exceeds payout as "⚠️ UNAFFORDABLE: DO NOT pursue this chain." This is too strict. In the early game, almost every delivery requires building track that costs more than the immediate payout. But that track has network value — it enables future deliveries too.

**Example (Game 2, Turn 5+):** Bot has card 65 (Wheat→Luxembourg, 10M). Luxembourg is connected to bot's track. Wheat is at Lyon (~21M of track away). Context says "UNAFFORDABLE" and bot never pursues it. But building toward Lyon also connects Marseille, Toulouse, and opens southern France for future cards. The bot passes turns doing nothing instead.

The scoring should rank all demand options and show that ranking in the debug overlay, accounting for network value (what cities/regions the track investment unlocks beyond the immediate delivery).

---

## Bug 12: Bot stuck with no loads — passes forever

**Severity:** Critical (game-blocking)

When the bot has no loads and all demand cards are flagged UNAFFORDABLE, the bot passes every turn indefinitely. Unlike Bug 6 (stuck WITH loads), Guardrail 4 doesn't fire because the bot isn't carrying anything. There's no escape mechanism.

**Example (Game 2, Turn 8+):** Bot has 3 demand cards, all requiring track investment exceeding their payout. Bot has no loads, no active route. LLM sees "DO NOT pursue" on all demands and chooses PassTurn. Repeats every turn. Game effectively over.

**Root cause:** Bug 11 (UNAFFORDABLE gate) combined with Bug 7 (no discard consideration) creates a terminal state.

---

## Priority Order for Fixes

1. **Bug 11 (UNAFFORDABLE gate)** — root cause of Bot 12; blocks all early-game play
2. **Bug 12 (stuck without loads)** — game-blocking, direct consequence of Bug 11
3. **Bug 6 (deadlock with loads)** — game-blocking
4. **Bug 2 (DropLoad)** — required to fix Bug 6; pipeline gap
5. **Bug 1 (ferry rules)** — critical game rule violation
6. **Bug 7 (discard hand)** — escape hatch when all cards are bad; mitigates Bugs 11/12
7. **Bug 4 (multi-pickup)** — easy efficiency win in TurnComposer
8. **Bug 3 (speculative pickup)** — prevents dead-weight accumulation
9. **Bug 5 (infeasible delivery)** — needs feasibility check in Scorer/OptionGenerator
10. **Bug 9 (build vs move priority)** — sequencing issue
11. **Bug 8 (wasted reversals)** — likely an LLM reasoning issue
12. **Bug 10 (premature building)** — strategic scoring improvement

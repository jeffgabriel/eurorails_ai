# JIRA-13: Demand Scoring & Bot Stall Bugs

Bugs observed during live gameplay on 2026-02-28.
- Game: `8cb4f8f5-8acf-406d-b99c-4a60a551641b`

Bugs 1-10 from JIRA-12 were fixed separately. This list covers the remaining issues.

---

## Bug 1: UNAFFORDABLE gate kills all early-game deliveries

**Severity:** Critical (causes Bug 2 — bot stuck doing nothing)

The demand scoring flags any delivery where track cost exceeds payout as "UNAFFORDABLE: DO NOT pursue this chain." This is too strict. In the early game, almost every delivery requires building track that costs more than the immediate payout. But that track has network value — it enables future deliveries too.

**Example (Turn 5+):** Bot has card 65 (Wheat to Luxembourg, 10M). Luxembourg is connected to bot's track. Wheat is at Lyon (~21M of track away). Context says "UNAFFORDABLE" and bot never pursues it. But building toward Lyon also connects Marseille, Toulouse, and opens southern France for future cards. The bot passes turns doing nothing instead.

**Root cause:** `ContextBuilder.formatReachabilityNote()` line 903 — binary `cost > payout` check with no consideration of network value.

**What needs to change:**
- Replace binary UNAFFORDABLE gate with a demand ranking algorithm
- Ranking should account for: immediate ROI, network value (cities/regions unlocked), victory progress (major cities en route), opportunity cost
- Surface the ranking in the debug overlay so scoring decisions are visible during gameplay

---

## Bug 2: Bot stuck with no loads — passes forever

**Severity:** Critical (game-blocking)

When the bot has no loads and all demand cards are flagged UNAFFORDABLE, the bot passes every turn indefinitely. Unlike JIRA-12 Bug 6 (stuck WITH loads), Guardrail 4 doesn't fire because the bot isn't carrying anything. There's no escape mechanism.

**Example (Turn 8+):** Bot has 3 demand cards, all requiring track investment exceeding their payout. Bot has no loads, no active route. LLM sees "DO NOT pursue" on all demands and chooses PassTurn. Repeats every turn. Game effectively over.

**Root cause:** Bug 1 (UNAFFORDABLE gate) combined with no discard-hand consideration creates a terminal state.

---

## Priority Order

1. **Bug 1 (UNAFFORDABLE gate)** — root cause; blocks all early-game play
2. **Bug 2 (stuck without loads)** — game-blocking, direct consequence of Bug 1

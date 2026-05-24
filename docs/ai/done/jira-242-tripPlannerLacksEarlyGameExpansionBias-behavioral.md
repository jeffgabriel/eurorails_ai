# JIRA-242 — Trip planner picks a single-pickup negative-NET trip over a pair-at-same-pickup-city tie because there's no early-game expansion bias (behavioral)

In game `8738866e-0f51-488a-bff1-a5fab6b80ff1`, bot s2 at t6 (post-Flowers delivery) replanned. Its hand contained two cards whose supply city is Birmingham (England): Iron→Antwerpen (payout 14M) and China→Ruhr (payout 7M). The trip planner enumerated 499 candidates and ranked the top three:

| Rank | Candidate | Payout | Build | Turns | NET | Aggregate |
|---|---|---:|---:|---:|---:|---:|
| 1 (chosen) | single Iron @ Birmingham | 14 | 22 | 6 | −8 | **0.18** |
| 2 | pair China+Iron @ Birmingham (BA order) | 21 | 29 | 7 | −8 | 0.17 |
| 3 | pair China+Iron @ Birmingham (AB order) | 21 | 29 | 8 | −8 | 0.15 |

The single won by 0.02 aggregate. But the pair pairs are *strictly more useful expansion*: same pickup-city visit (Birmingham, behind a ferry), two cards consumed instead of one, more network laid in the same direction. In early game, the planner should bias toward the pair when the raw scores are near-tied — that's the "controlled expansion" frame.

Negative-NET trips are normal in early game (capitalism: you must spend money to make money). The defect is not that the bot picks a −8M trip — it's that the planner's aggregate-velocity tiebreak ignores the *expansion value* of a route that consumes 2 cards instead of 1 at the same pickup-city investment.

## Source

`logs/game-8738866e-0f51-488a-bff1-a5fab6b80ff1.ndjson` — bot s2, t6 (replan after Flowers@Holland delivery). Discovered 2026-05-16.

## Observed trace

| Turn | s2 cash | s2 action | Top-1 chosen | Effect |
|------|--------:|-----------|--------------|--------|
| t6 | 40 | MoveTrain (replan) | `single:49:Iron-sup:Birmingham` (single, 6t, NET −8, agg 0.18) | Pair-at-Birmingham RU#2 lost by 0.02 |
| t7–t11 | 40→28 | Build/Move toward Birmingham | Bot ferrying to England for one card; cash drops |
| t12 | — | (next replan triggers a different route entirely) | Pair China+Iron never executed |

The China card was a separate, never-amortized commitment. By t10 the China card had been swapped for a different China-at-Birmingham draw (cards rotate on deliveries), but the *original* multi-pickup-at-Birmingham opportunity was already passed up.

## Expected behavior

When the bot is in early game (turns 4–25), candidates with ≥2 delivery stops should receive a small expansion bonus (+0.05 M/turn) on `aggregateScore`. This:

- tips ties of 0.02–0.05 magnitude toward multi-delivery routes,
- does not override clearly better single-delivery candidates,
- compounds the planner's existing chained two-trip look-ahead rather than replacing it.

At t6 with the bonus applied:

- Single Iron — 0.18 (no bonus, 1 delivery)
- Pair BA — 0.17 + 0.05 = **0.22** ← wins
- Pair AB — 0.15 + 0.05 = 0.20

The bot would execute the pair, picking up both Iron and China at Birmingham, delivering both, amortizing the ferry-and-build investment across two payouts (21M total vs 14M).

## Game-phase model

To house this and future early-game tweaks cleanly, formalize an `Early` phase alongside the `Initial`/`Mid`/`End` phases introduced by JIRA-241:

| Phase | Turn range | Notes |
|---|---|---|
| `Initial` | turns 1–3 | Setup-build turns (1–2) plus the first regular turn (3). Still implicit in code; no behavioral change. |
| `Early` | turns 4–25 | **NEW.** The new multi-delivery bonus fires here. |
| `Mid` | turn ≥ 26 (and cash ≤ 200M) | The bonus also fires here, per the design — "early expansion" momentum carries into mid. |
| `End` | cash > 200M (ever, latched) | JIRA-241 scoring takes precedence; the bonus does not apply. |

`Early` is turn-bracketed, not latched — turn numbers monotonically increase, so the transition out is automatic at turn 26.

## Acceptance

- **AC1 — phase transitions:** `computeGameState({ turnNumber: 3 }, …)` returns `Initial`; `turnNumber: 4` returns `Early`; `turnNumber: 25` returns `Early`; `turnNumber: 26` returns `Mid`. End/cash latching from JIRA-241 still takes precedence at every turn.
- **AC2 — bonus fires in Early for multi-delivery:** in an `Early` state context, two feasible candidates A (single delivery, aggregate 0.18) and B (pair, aggregate 0.17). After scoring, B's effective aggregate is 0.22 and wins.
- **AC3 — bonus does NOT fire for single-delivery:** A (single, 0.18) keeps aggregate 0.18 unchanged.
- **AC4 — bonus fires in Mid too:** same fixture as AC2 with `gameState=Mid`. B still wins.
- **AC5 — bonus does NOT fire in End:** in `End` state, JIRA-241's `applyEndStateScoring` substitutes `aggregateScore` wholesale, and the bonus is absent from that substitution. Pair B does not receive the +0.05 in end.
- **AC6 — bonus does NOT fire in Initial:** at `turnNumber=3`, scoring matches today's behavior (no bonus added). Verifies the gate.
- **AC7 — regression on game 8738866e s2 t6:** reconstruct the t6 snapshot (cash 40, hand contains the 9 demand cards listed in the log, network includes the Holland→Flowers delivery track). Run `planTripDeterministic`. Assert the chosen route is one of the China+Iron pair variants at Birmingham, NOT the single Iron.

## Not in scope

- Adjusting the existing aggregate two-trip look-ahead formula — kept as-is.
- Changing prune caps (max-build, max-turns) in early game — same as mid.
- Special ferry treatment — ferries cost what they cost; the bonus is the only early-game lever.
- Per-extra-delivery scaling (triple > pair > single) — flat bonus regardless of count beyond 1.
- A "controlled expansion" signal richer than turn number (track re-use probability, corridor proximity, etc.) — explicitly rejected during design.
- Formalizing the `Initial → Early` transition's underlying semantics or adding setup-turn logic; `Initial` remains a label only.

# JIRA-199 — Bot passes turn instead of discarding when its hand is unaffordable

## Symptom

A bot with cash, no active route, and no carried loads sits on `PassTurn` for many turns when none of its three demand cards can be profitably serviced from its current position with its current bankroll. The cards aren't intrinsically bad — position × network shape × card geography × cash line up badly, the brain marks every option "unaffordable", and the bot does nothing instead of recycling the hand.

## Why this matters

`PassTurn` is **only** legal when the bot is mid-route and has run out of built track on the way to a known pickup or delivery. That is the only condition under which passing is the correct action. Anywhere else, `PassTurn` is a bug — including (and especially) "the brain couldn't think of an affordable plan."

If the bot can't move toward a delivery, it should build. If it can't build, it should reposition. If it truly can't do anything productive on this hand, it should discard. A long `PassTurn` loop is the most expensive way the bot can fail.

## Evidence — game `c4b4c111-eaec-4c16-a7ad-0573afb012c5`

Bot **Nano**:
- Cards `{23, 83, 66}` — supply cities sit in the western/southern map (Bilbao, Napoli, Sevilla, Oslo, Zurich, Cardiff, …).
- Network: a north–south corridor in the east (Wien / Budapest / Warszawa / Kaliningrad / Sarajevo / Lodz).
- Pawn parked deep in that east corridor (row 34, col 60).
- 40M cash — not broke, but nowhere near enough to build a westward corridor *and* finance the delivery *and* keep operating capital.
- No carried loads. No active route.

**Turns 19 – 32**: 14 consecutive `PassTurn` actions. Cash flat at 40M. Zero track, zero pickups, zero deliveries. Brain on every turn: *"All demand cards UNAFFORDABLE for the required build/supply connection from current network."* None of those 14 turns met the legal `PassTurn` condition — Nano had no active route at all. The bot finally discarded on turn 33 and resumed normal play on turn 34.

## Expected behaviour

At the start of a turn, if the bot has no active plan, no deliverable carried load, and every card in hand is unaffordable to service from the current position/network/cash → it must `DiscardHand`, not `PassTurn`.

`PassTurn` stays reserved for its single legal case: active route, all reachable track exhausted toward the next pickup/delivery, no further legal movement this turn.

## What success looks like

- No `PassTurn` runs longer than the strict "out of track on an active route" case allows.
- Replay of `c4b4c111` shows Nano discarding around turn 19, not turn 33.

## Out of scope

- The affordability check itself — the brain's verdict is correct.
- Letting the bot ignore its cash limit (debt, speculative builds).
- Partially-playable hands (one affordable, two not).
- Starting-city / initial-build decisions.

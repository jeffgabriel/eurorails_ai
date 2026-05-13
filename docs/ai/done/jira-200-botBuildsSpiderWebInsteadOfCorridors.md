# JIRA-200 — Haiku built a spider-web of track in one region of one game

## Symptom

In game `c4b4c111-eaec-4c16-a7ad-0573afb012c5`, in a single ~12×16 region of the map (rows 18–30, cols 55–70, around the Kaliningrad / Warszawa / Lodz area), bot **Haiku** built a tangled mess of track — many short radial branches, multiple dead-end stubs that don't lead to any city or pickup, and several overlapping/parallel branches between the same pair of cells. The shape doesn't look like transport corridors between cities; it looks like a sunburst.

We have only observed this once, in this game and this region. We don't know yet whether it's a general pattern across games, a regression tied to a specific recent change, or a one-off triggered by something specific to Haiku's situation in `c4b4c111`. **The cause is unknown.**

## Why this matters

Per the project's bot strategic principles:

> Track is an investment, not a cost. Every segment built should have a clear expected return: a delivery it enables, a major city it connects, or a route it shortens. Track that doesn't connect to revenue or victory is wasted capital.

A dead-end spoke is the textbook definition of speculative track — paid for in cash, leads nowhere. Whatever produced this network in this game burned ECU on segments that contributed nothing toward deliveries or the seven-major-cities victory condition. Even as a one-off it's worth understanding: a bot that *can* produce this shape under any conditions can probably produce it again.

It's also the most visually obvious "bot-played-this" tell on the map.

## Evidence — game `c4b4c111-eaec-4c16-a7ad-0573afb012c5`, bot Haiku

Track segments restricted to rows 18–30, cols 55–70 (the area around `(24, 62)`):

| Metric | Value |
|---|---|
| Segments in region | **52** |
| Hub nodes (degree ≥ 4) | **5** — `(25, 62)` degree 6, `(24, 62)` / `(23, 62)` / `(20, 60)` / `(20, 58)` each degree 4 |
| Dead-end stubs (degree 1) | **21** |
| Junctions (degree 3) | 7 |
| Plain corridor cells (degree 2) | 19 |

Concrete dead-end examples around the `(25, 62)` hub: `(24, 63)`, `(25, 63)`, `(25, 61)`, `(26, 63)` — four separate one-segment stubs from the same milepost, none leading to a city or a pickup.

For a sense of scale: in this one region, dead-end stubs (21) outnumber plain corridor cells (19). That ratio doesn't match a network of corridors connecting cities.

## Expected behaviour

We don't know the cause yet, so the expected behaviour is stated at the network-shape level rather than as a fix prescription:

- The bot's track in `c4b4c111` around `(24, 62)`, on a replay or equivalent setup, should look like transport corridors between Kaliningrad / Warszawa / Lodz, not a sunburst around individual mileposts.
- In that region specifically: dead-end count should not exceed corridor-cell count, and no single milepost should accumulate 5–6 outgoing tracks unless it's genuinely the meeting point of that many distinct long-distance corridors (which it isn't, here).
- Whatever the bot was *trying* to do across those turns, the resulting network should reflect a coherent across-turn intent — successive turns extending an in-progress route — not what looks like 30 separate "build something nearby" decisions.

## What success looks like

- Reproducing or replaying the conditions Haiku faced in `c4b4c111` does not produce a sunburst-shaped network in the Kaliningrad / Warszawa / Lodz region.
- Whatever caused this is identified, named, and either fixed or has a written rationale for why we accept it.
- We can articulate the cause clearly enough to know whether to expect it elsewhere, or whether it's genuinely a one-off for this game's specific state.

## Out of scope

- Asserting that this happens in other games or other regions. We have one observation. Investigation may broaden the scope; this ticket should not pre-assume it.
- Changing the per-cell build cost model or the major-city red-area rules. The bug is about which cells the bot chose to build, not the cost of building them.
- The east-boundary zigzag framing from the original report — that was a hypothesis that doesn't fit the evidence (the spider web is interior, not at the map edge). Drop it.
- Prescribing an algorithm. We don't know what's wrong yet; the fix shape should follow the diagnosis.

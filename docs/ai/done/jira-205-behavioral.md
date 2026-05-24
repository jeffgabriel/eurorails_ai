# JIRA-205 — Build advisor returns ~70-token responses every turn, producing 1-segment builds while a 20M budget sits unused

A bot whose active route requires extending track to a target city emits a single tiny build segment per turn for many consecutive turns. Each turn consumes 1–5M ECU of build budget when 20M/turn is available and the bot has more than enough cash to afford a full corridor. The accumulated single-segment builds form a starfish of disconnected mini-stubs near the target rather than one coherent corridor that reaches it.

## Game evidence — `d7c3fd78-fcf3-40d9-8d59-8bf95a2fa60e`

Player: **Flash** (`gemini-3-flash-preview`).

Active route on T52–T70 (the relevant stretch):
1. `pickup Oil at Newcastle` ← `currentStopIndex = 0` from T62 onward
2. (later stops vary; not relevant)

Cash on T66: **63M ECU**. Build budget per turn: **20M**. There is no money problem.

Every turn from T52 onward, the build advisor's recommendation drives a build whose total cost is a small fraction of the available budget:

| Turn | Built segment(s) | Cost | Reaches target? |
|---|---|---|---|
| T52 | `(13,29)→(12,30)→(11,30)→(10,31)→(10,32)` (4 segs) | 7M | No (endpoint 1 milepost short) |
| T61 | `(10,31)→(9,31)` | 2M | No |
| T62 | `(9,31)→(8,32)` | 2M | No |
| T64 | `(10,31)→(9,30)` | 1M | No (branches off (10,31), creates Y-fork) |
| T65 | `(10,33)→(11,32)` | 1M | No (orphan — starts at a cell not on the network) |
| T66 | `(11,30)→(11,31)` | 1M | No |
| T68 | `(9,31)→(8,31)` | 1M | No |
| T70 | `(8,32)→(7,32)` | 2M | No |

The target city, **Newcastle**, never gets connected. Across these 8 build turns the bot spent ~17M of an available 160M (8 × 20M), and produced a tangle of micro-stubs instead of the single coherent corridor that the same budget would have funded in a single turn.

## What the build advisor returned each turn

The build advisor LLM call is `caller=build-advisor`, `method=adviseBuild`, model `gemini-3-flash-preview`. Across all of T52, T61, T62, T64, T65, T66, T67, T68, T69, T70, the advisor's `responseText` is **truncated mid-sentence**. Output tokens used per call:

| Turn | Output tokens | Response tail |
|---|---|---|
| T52 | 69 | `…[23, 31],     [22, 31],     [21,` |
| T61 | 65 | `…ng track network already reaches (10, 32` |
| T62 | 67 | `…existing network terminus at (10,32) to` |
| T64 | 69 | `…"Connecting the existing network at (9, ` |
| T65 | 69 | `…ting network at (9, 31) to Newcastle (9,` |
| T66 | 70 | `…xisting track network already reaches (9` |
| T67 | 70 | `…sting 3M ECU, which is well within the 2` |
| T68 | 68 | `…is a Medium City adjacent to my existing` |
| T69 | 65 | `…e existing track at (9, 31) to Newcastle` |
| T70 | 66 | `…located at (9, 33), which is adjacent to` |

Every call is cut mid-word at 65–70 output tokens. The response is never long enough to contain a full corridor of waypoints — at best it yields one or two `[row, col]` pairs at the very start of the JSON (and even those sometimes cut off before the closing brace). T66's full response is illustrative:

```
{ "action": "build", "target": "Newcastle",
  "waypoints": [ [9, 31], [9, 32] ],
  "reasoning": "Newcastle is located at (9, 32). My existing track network already reaches (9
```

The downstream resolver gets a 2-waypoint stub and produces a 1-segment build. Next turn, same thing happens with a slightly different stub — sometimes anchored to a different frontier point, sometimes to a cell that isn't even on the network — and the network grows another spur instead of a corridor.

## The starfish, end-to-end

By T70 the UK build cluster around Newcastle looks like this on Flash's track (chains as reported in the corridor map shown to the LLM at T66):

- Main approach chain: `Birmingham(16,30) → (15,29) → (14,29) → (13,29) → (12,30) → (11,30) → (10,31) → (9,30) → (9,31) → (10,32)`
- Orphan: `(9,31) → (8,32)`
- Orphan: `(10,33) → (11,32)`
- Plus per-turn additions: `(11,30)→(11,31)`, `(9,31)→(8,31)`, `(8,32)→(7,32)` — each a separate degree-1 stub

There are 4–5 dead-end spurs and an unconnected orphan pair within a 6×4 region. The target (Newcastle, ~`(9,32)`) is one milepost from the main chain's endpoint, but never gets connected; instead, every turn the bot extends *somewhere else nearby*.

## Why it matters

Per the project's North Star: build budget is the bot's most concentrated weapon, and corridor coherence is the difference between reaching a delivery and not. The behaviour observed here turns 20M/turn into 1–2M/turn of useful work and never closes the last milepost gap. Across 18+ stuck turns (T67–T85 the bot eventually loops on Build/PassTurn at the same train coordinate), this single advisor failure mode burned the entire mid-game's build velocity for Flash.

We have observed this in **one game and one player**. The pattern is consistent enough across 10 consecutive advisor calls in that game that it is highly unlikely to be a single-call flake — but we have not yet verified whether it reproduces in other games or with other models. The ticket scope is the observation as recorded above.

## Out of scope

- Why Flash's train is stranded at `(12,46)` while building in `(8–13, 29–33)` — that is a separate "train and build are in disconnected components of the player's network" defect; it has its own ticket.
- Generalising to "any time advisor returns short, replan." The trigger here is specifically: **advisor response truncated, build candidate is shorter than the gap to target, budget is unspent.**
- Behaviour with other LLM providers or models. The observation is `gemini-3-flash-preview`; other models may or may not exhibit this.
- The build resolver's handling of partial waypoints. The waypoints it received were honest given what the advisor returned; the bug is upstream.

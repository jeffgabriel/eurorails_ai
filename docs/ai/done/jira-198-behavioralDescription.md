# JIRA-198 — Bots never upgrade their trains, even when they want to

## Symptom

Bots play entire games on the starting Freight train (9 mileposts/turn, 2 cargo slots) regardless of how much cash they accumulate or how many deliveries they complete. They never crossgrade to Fast Freight or Heavy Freight, and never upgrade to Superfreight.

This is true even when a bot is sitting on 100M+ ECU and has completed many deliveries — far more than enough to comfortably afford the 20M upgrade cost.

## Why this matters

Per the project's bot strategic principles, train upgrades are an explicit part of "winning play":

> Upgrade the train when the math supports it. 20M for +3 speed (Freight→Fast Freight) pays for itself quickly if the bot is movement-constrained. Don't hold a Freight train for 100 turns when an upgrade would accelerate every future delivery.

A bot stuck on Freight for an entire game runs at 75% of the speed of a Fast-Freight opponent, and at 67% of the cargo capacity of a Heavy Freight. Over the course of a long game, this is a permanent compounding disadvantage that makes it nearly impossible for the bot to keep pace with a thinking opponent or to reach the seven-major-cities + 250M cash victory condition.

## Evidence — game `76663d98-288b-499b-8f4d-ceb8e09ad573`

Three bots played roughly 90 turns. Their final state:

| Bot   | Deliveries | Total payout | End cash | End train |
|-------|------------|--------------|----------|-----------|
| Nano  | 10         | 213M         | 106M     | Freight   |
| Haiku | 7          | 144M         | 38M      | Freight   |
| Flash | 7          | 111M         | 44M      | Freight   |

Nano in particular ended the game with more than five times the cost of an upgrade in cash, having delivered ten times, still on the slowest train.

This is not a question of the bot deciding upgrades aren't worth it. The bot's planning brain explicitly *asked* to upgrade across the game:

| Turn | Bot   | Deliveries-so-far | Cash | Bot requested | What actually happened |
|------|-------|-------------------|------|---------------|------------------------|
| 43   | Nano  | 5                 | 29M  | Upgrade to Fast Freight | No upgrade — bot moved instead |
| 52   | Nano  | 6                 | 65M  | Upgrade to Fast Freight | No upgrade — bot moved instead |
| 66   | Nano  | 7                 | 81M  | Upgrade to Fast Freight | No upgrade — bot moved instead |
| 79   | Nano  | 8                 | 92M  | Upgrade to Fast Freight | No upgrade — bot moved instead |
| 86   | Haiku | 4                 | 49M  | Upgrade to Fast Freight | No upgrade — bot moved instead |
| 91   | Haiku | 6                 | 41M  | Upgrade to Fast Freight | No upgrade — bot moved instead |

Across the whole game, the bots' planning brains asked to upgrade **19 times**. The bots executed an upgrade **0 times**.

## Expected behaviour

When a bot's planning brain decides an upgrade is the right move and the bot has enough cash to afford it, the upgrade should actually happen on that bot's turn — replacing what would have been a track-build with a train upgrade, while still allowing the bot's normal movement, pickups, and deliveries that turn.

Specifically, the upgrade decision and execution should work whether the bot is:
- Just starting a brand-new delivery plan, OR
- Continuing through a multi-stop plan it built on an earlier turn (the more common case in any reasonable game)

Today, only the first case actually executes the upgrade. The second case — which is where bots spend the vast majority of their playing time once a game gets going — silently drops the upgrade request.

## What success looks like

After the fix, replaying a similar 80–100 turn game should show:
- At least one bot reaching Fast Freight by roughly turn 25–35 (after clearing the early-game delivery threshold that gates upgrades)
- Bots with strong income trajectories (50M+ cash for many turns) reaching Superfreight in the mid-to-late game
- A noticeable improvement in deliveries-per-turn after upgrades, and a tighter overall game length

## Out of scope

- Changing how the bot *decides* whether to upgrade. The decision logic is working — bots are correctly identifying upgrade opportunities and asking for them. The bug is purely that those decisions aren't being honored.
- Changing the early-game protection that prevents upgrades before the bot has completed enough deliveries to safely afford one. That gate is doing its job and should remain.
- Adding any new "force upgrade after N turns" rule. The bot's brain is already requesting upgrades at sensible times — we just need to honor those requests.

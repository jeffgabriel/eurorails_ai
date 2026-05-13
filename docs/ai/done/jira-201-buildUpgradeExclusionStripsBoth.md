# JIRA-201 — Bot drops LLM upgrade when the same turn also has a build

## What's broken

When the LLM emits `upgradeOnRoute` on a turn that also includes a track-build action, the bot does neither — it stays on its current train and skips the build. From the LLM's view the upgrade was approved; from the bot's view nothing happened. Bots that are movement-constrained and cash-rich keep getting upgrade signals, all silently lost, while the bot crawls along on `freight` for the entire game.

## Evidence (game `2436f0c9-1f52-4d8c-8fb4-d7a7734199be`)

Flash sat on 100M+ ECU and emitted `upgradeOnRoute: FastFreight` four times. Every signal landed on a turn that also planned a build. None of the upgrades fired. Flash ended turn 38 still on `freight`.

| Turn | Cumulative deliveries | Start cash | LLM said | Bot did |
|---|---|---|---|---|
| 6  | 0→1 | 38M | upgradeOnRoute=FastFreight | move + deliver, no upgrade, no build |
| 11 | 1→2 | 20M | upgradeOnRoute=FastFreight | move + deliver, no upgrade, no build |
| 19 | 3→4 | 18M | upgradeOnRoute=FastFreight | move + deliver, no upgrade, no build |
| 28 | 5→6 | 63M | upgradeOnRoute=FastFreight | move + deliver, no upgrade, no build |

In the same game, Haiku and Nano upgraded successfully — but only on turns where their plan happened to contain no build action.

## Why it matters

Per the project's North Star: a bot at 9 mileposts/turn sitting on 100M+ cash is the textbook case for an upgrade. Flash spent the entire game in that state, getting four explicit "upgrade now" signals from the LLM, and acted on none of them. The bug turns LLM strategy into noise whenever the composition pipeline adds any build target — which is most turns once a route extends off-network.

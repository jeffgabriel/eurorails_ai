# JIRA-260 — Haiku stuck in an infinite Derailment "lost turn" loop in an all-bot game (behavioral)

In game `f3ed7b8f-8ebb-45f9-9010-90c3fbfac628` (an all-bot game — Haiku + Sonnet), Haiku drew or was caught by Derailment event card #125 on or before turn 41. Per the game rules, a Derailment causes the affected player to **lose one turn** and **one load**. Haiku then passed turns 41 through 47 (at least) consecutively, every turn emitting the identical reasoning string `"Lost turn due to Derailment event card #125."`. The pending-lost-turn entry that should have been consumed after the first PassTurn was never cleared, so the lost-turn pre-emption fired again every time Haiku's turn came back around.

## Source

`logs/game-f3ed7b8f-8ebb-45f9-9010-90c3fbfac628.ndjson`, Haiku turns 41 through 47 (and probably continuing past 47 — the log shows the loop still ongoing when the snapshot was taken).

## Observed trace — Haiku

| Turn | action | reasoning |
|------|--------|-----------|
| 40 | UpgradeTrain | `[route-executor] stop 1/2, phase=build; replan triggered\n\nSheep Bilbao→Lodz is the highest-efficiency option …` |
| 41 | PassTurn | `Lost turn due to Derailment event card #125.` |
| 42 | PassTurn | `Lost turn due to Derailment event card #125.` |
| 43 | PassTurn | `Lost turn due to Derailment event card #125.` |
| 44 | PassTurn | `Lost turn due to Derailment event card #125.` |
| 45 | PassTurn | `Lost turn due to Derailment event card #125.` |
| 46 | PassTurn | `Lost turn due to Derailment event card #125.` |
| 47 | PassTurn | `Lost turn due to Derailment event card #125.` |

The reasoning string and the persistent `card #125` reference indicate the lost-turn pre-emption in `AIStrategyEngine.takeTurn` is firing every time — meaning `snapshot.activeEffects` still contains an effect with `pendingLostTurns: [{ playerId: <Haiku> }]` on every one of these turns.

## Expected behavior

Per the rulebook: "When a Derailment Event occurs, only trains in the affected area at the moment the card is drawn are impacted. … When a train loses a load, the player operating the train chooses which load is lost from those currently being carried." And: a Derailment causes the affected player to **lose one turn and one load**, then the player's regular turns resume.

Concretely:
- After Haiku consumes the lost turn on T41 (the first PassTurn), the corresponding `pendingLostTurns` entry for Haiku should be removed.
- T42 should be a normal Haiku turn — back to building, moving, delivering.
- The Derailment ActiveEffect itself should also expire at the end of the drawing player's next turn (per the rulebook's general Event card lifecycle).

## Acceptance

- **AC1** — Reproducer fixture: Haiku snapshot at T41 with `activeEffects: [{ cardId: 125, cardType: 'Derailment', pendingLostTurns: [{ playerId: <Haiku> }], … }]`. After Haiku's T41 turn completes (PassTurn via lost-turn pre-emption), `pendingLostTurns` for Haiku should be empty in the persisted `games.active_event` row.
- **AC2** — Replay T42 against the persisted state from AC1. Assert: `isBotInPendingLostTurns(snapshot.activeEffects, <Haiku>)` returns false. AIStrategyEngine.takeTurn does NOT fire the lost-turn pre-emption. Haiku's normal planning path runs.
- **AC3** — All-bot integration test: two bots, one of them draws Derailment, gets a pending lost turn. After 1 full round (both bots take their turn), assert the pending lost turn for the affected bot is gone.
- **AC4** — Mixed game regression guard: human + bot game. Bot gets a Derailment pending lost turn. After bot turn ends and human plays, assert pending lost turn is gone (existing transactional path should still fire — this is a guard that the fix doesn't break it).
- **AC5** — Replay Haiku T41 of `f3ed7b8f-8ebb-45f9-9010-90c3fbfac628` and assert the bot does NOT enter the multi-turn loop.

## Not in scope

- Load loss accounting (which carried load is dropped on Derailment, and the rulebook's "player chooses" wording). This ticket scopes to the lost-turn portion. If load-loss has a parallel bug, file separately.
- Derailment area-of-effect (the 3-mileposts-from-affected-cities zone). The current implementation appears to be computing it correctly — Haiku's pending entry implies the zone hit Haiku. This ticket scopes to consumption, not detection.
- LLM-side reasoning. The lost-turn pre-emption is a deterministic system-actor path; no model reasoning is involved.

## User-facing impact

For all-bot games, any Derailment effectively removes the affected bot from the game for the remainder of play. Haiku in this game has lost 7+ turns and counting, with no way out — the game would have to end on victory by another player (or stall). For mixed games with at least one human, the existing transactional turn-advance path (called when the human's turn ends) would consume the bot's lost turn correctly, masking the bug.

## Likely-related adjacent observation (in scope for the same fix locus)

In game `182bfd36-3d3d-46ef-9c1d-0c87373b983f` (the prior JIRA-256 testing game, also all-bot), Coastal Strike rejections continued across multiple turns for Haiku at London and s1 at Antwerpen. Strikes are supposed to expire after the drawing player's next turn. The persistence-of-restrictions pattern there matches the persistence-of-lost-turns pattern here: both are managed by the same `ActiveEffectManager` operations (`consumeLostTurn` + `cleanupExpiredEffects`), and both gates run inside the transactional path of `PlayerService.updateCurrentPlayerIndex`. The same code locus likely affects expiration of all event cards in all-bot games. Worth verifying during implementation; if confirmed, an AC for "Strike expires after drawing player's next turn in an all-bot game" should be added alongside AC3.

## Relationship to existing JIRAs

- **JIRA-256 / BE-005 / BE-007**: BE-005 added the lost-turn pre-emption in `AIStrategyEngine.takeTurn`, and BE-007 added the mid-turn re-snapshot for activeEffect changes. Both correctly *detect* a pending lost turn; neither attempts to *consume* it. The consumption path predates JIRA-256 and lives in `ActiveEffectManager.consumeLostTurn`, but is only reachable via the transactional path of `PlayerService.updateCurrentPlayerIndex` (which `BotTurnTrigger` does not use).
- **JIRA-257 / JIRA-259**: these fixed the planner/guardrail not consulting active restrictions, but the underlying issue here is different — the restriction *should* eventually clear and is not, due to the bot-only turn-advance bypassing effect lifecycle hooks.

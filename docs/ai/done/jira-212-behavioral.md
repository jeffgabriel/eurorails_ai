# JIRA-212 — Bot meets victory conditions but game does not end; autoplay continues indefinitely

## Game evidence

- Game: `66e3eebc-099c-4c18-8590-f54ed3a70fe3`
- Log: `logs/game-66e3eebc-099c-4c18-8590-f54ed3a70fe3.ndjson` (4,580 lines)
- Bots: Haiku, Flash, Nano (all bot players)

## What happened

On **turn 121**, Haiku's NDJSON turn entry shows `cash: 259` (i.e. 259M ECU) and `connectedMajorCities: ["Paris", "Holland", "Milano", "Ruhr", "Berlin", "London", "Wien"]` — exactly the win condition (≥ ECU 250M and ≥ 7 connected major cities).

The game did not end. It continued for **1,407 additional turns** (122 → 1,528), the point at which the log simply stops. Within that span:

- Flash met the same win condition on turn 123 (cash 304, 7 cities).
- Nano met it on turn 185 (cash 264, 7 cities).
- The `gamePhase` field switched to `"Victory Imminent"` starting turn 108 (this phase is a context heuristic, not the actual victory trigger — see Out of scope).
- The last LLM-driven decision is on turn 1,466. Turns 1,467 → 1,528 are exclusively `actor: "system"`, `decisionSource: "route-executor"`, action `MoveTrain` — i.e. autonomous route execution with no strategy layer engaged.
- No turn entry in the log indicates the game transitioned to a terminal state.

The game's `status` column must have stayed `active` for the entire run, because `BotTurnTrigger.onTurnChange` short-circuits at the top when status is `completed` / `abandoned` (`src/server/services/ai/BotTurnTrigger.ts:82-85`), and bot turns kept executing for 1,400+ rounds.

## What we wanted

When a bot first satisfies the win condition at end-of-turn, the server should declare victory, enter final-turn mode for the predecessor player, resolve the game on the next pass, set `status = 'completed'`, and stop scheduling further bot turns. None of that happened in this game.

## Player-visible impact

A game that should have ended at turn ~123 (after Haiku's predecessor took the closing turn) instead ran 1,400+ extra turns of autonomous train-shuffling. The route-executor kept the game alive in autoplay long after it should have terminated, with no strategic decisions being made and no observable progress toward any goal.

## Scope

Single observation in a single game (`66e3eebc-099c-4c18-8590-f54ed3a70fe3`). Not generalizing to other games or to claim this happens every time a bot wins.

## Out of scope

- The `"Victory Imminent"` `gamePhase` heuristic (`NetworkContext.computePhase`, fires at 5 cities + 250M or 6 cities + 230M). That is a separate signal used to prime the LLM and is not the actual victory trigger.
- Whether the LLM should have stopped consulting earlier (turn 1,466 is when the strategy layer last fired). The fact that decisions stopped emerging is a downstream symptom of the never-ending game, not a separate concern.
- Whether route-executor's autoplay should be capped at some turn count as a fail-safe. Possible follow-up; not in scope here.
- Client-side victory rendering. The server never declared victory, so the client never received the event.

# JIRA-272 — Replan-after-delivery is conditional, not structural: the same bug keeps showing up at different control-flow waypoints

JIRA-269, JIRA-270, and JIRA-271 are the same family. Each was a code path that took action after a delivery (or in lieu of planning) without first replanning. Each fix neutralized one `if` gate. The obligation "replan before taking further action" lives implicitly across the bot turn pipeline — gated by different conditions at each call site, with the bot's position in the turn encoded in the call stack rather than as state.

## Source

- **JIRA-269** (`5663d13`): the dispatcher gated new-route planning on `hasLLMApiKey`. Medium bots fell through to PassTurn no-api-key.
- **JIRA-270** (`ac8c107`): `PostDeliveryReplanner` gated TripPlanner consultation on `!brain`. Medium bots skipped the replan entirely.
- **JIRA-271** (open): `MovementPhasePlanner` consumes remaining movement budget after a route-completing delivery with no plan in hand (game `c73cccf8` T23 — Stuttgart out-and-back).

Shared signature: an action taken after a delivery without first guaranteeing the replan ran.

## Expected behavior

The replan obligation after a delivery must be **structural**, not conditional. The pipeline must fail closed: any control-flow path that reaches "do something" — move, build, upgrade, drop — after a delivery, without having transited the replan step, should be a structural impossibility, not a forgotten `if`.

The same property must hold regardless of skill or credential presence. Replan is a property of the turn, not of the bot config. No `if (brain)` or `if (skillLevel)` branch should be able to decide whether the replan happens.

## Scope

Post-delivery replan obligation specifically. Narrower than a full bot-turn-pipeline state-machine refactor. JIRA-271 lands on the new structural shape; JIRA-269 and JIRA-270 must not regress.

## Out of scope

- Full bot-turn pipeline state-machine refactor.
- `AIStrategyEngine` god-service decomposition.
- TripPlanner enumeration / scoring changes.
- The exact technical shape (enum, FSM, types) — behavioral requirement only.

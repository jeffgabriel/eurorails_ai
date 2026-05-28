# JIRA-269 — Medium bots pass every turn with `[no-api-key] No LLM API key configured — passing turn` once the initial route completes

Regression from JIRA-268. Medium is deterministic; it should never reach a code path that gates on LLM credentials.

## Source

`logs/game-c73cccf8-919e-462c-8250-28b2199665a4.ndjson`, player s1, T2–T8. New game on commit `45b39db`. 2026-05-27.

## Trace

| Turn | action | reasoning |
|------|--------|-----------|
| T2–T4 | BuildTrack | initial build + route execution, normal |
| T6+ | DiscardHand | `[no-api-key] No LLM API key configured — passing turn` |

Every Medium game ends in practice as soon as the initial route completes.

## Expected behavior

When the bot needs a new plan, the dispatcher hands the request to a planner. The planner decides LLM vs deterministic based on the bot's skill. The dispatcher does not inspect credentials or skill level.

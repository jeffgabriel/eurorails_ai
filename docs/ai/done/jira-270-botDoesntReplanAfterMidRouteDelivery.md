# JIRA-270 — Bot doesn't replan after a mid-route delivery, ignoring the new demand card drawn at delivery time

Per game rules, every delivery causes a new demand card to be drawn. The new card can change what's optimal — most acutely when the pickup city of the new card is the bot's current position. The bot should consider replanning after every delivery, not skip the evaluation just because the current route has remaining stops.

## Source

`logs/game-c73cccf8-919e-462c-8250-28b2199665a4.ndjson`, player s1, T15–T17. Game ran after JIRA-269 fix landed.

## Trace

| Turn | action | delivered | remaining route after |
|------|--------|-----------|-----------------------|
| T9 | BuildTrack (trip-planner-deterministic) | — | `pickup Bauxite@Budapest, pickup Beer@Munchen, deliver Beer@Hamburg, deliver Bauxite@Munchen` |
| T15 | MoveTrain (route-executor) | Beer@Hamburg ($9) | `deliver Bauxite@Munchen` (1 stop) |
| T16 | MoveTrain (route-executor) | — | (executing) |
| T17 | MoveTrain (route-executor) | Bauxite@Munchen ($14) | (route complete) |

At T15 immediately after the Hamburg delivery, the bot's demand hand contains `Imports: Hamburg → Glasgow @ $24`. The bot is standing in Hamburg. Picking up Imports right there is a zero-detour, zero-cost-to-position opportunity that splices in cleanly before continuing west to Munchen. The bot does not consider it. It continues 2 turns west for a $14 Bauxite delivery while a $24 Imports pickup is one milepost-of-zero-cost away.

## Expected behavior

Every delivery triggers a new demand-card draw. After every delivery, the bot should re-evaluate whether the current route is still optimal given the new demand state. The decision can still be "keep going" — that's fine — but it must be a decision made by comparison against the post-delivery demand hand, not a reflex.

The evaluation must apply regardless of how many stops remain in the current route. A mid-route delivery is just as much a card-draw event as a route-terminating delivery; both reshape the demand landscape.

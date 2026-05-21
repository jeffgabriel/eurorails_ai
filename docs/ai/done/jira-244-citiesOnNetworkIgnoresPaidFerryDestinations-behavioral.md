# JIRA-244 — `citiesOnNetwork` excludes paid-ferry destinations, causing terminal PassTurn livelock when delivery target is a ferry-pair city (behavioral)

In game `c990fa47-bfc1-4437-9fc3-f148034c32f6`, player s1 emitted **43 PassTurn actions out of 61 turns** and made only 3 deliveries totaling $44M. s2 and s3 (same game, same logic) each emitted 0 PassTurns and 16–17 deliveries. s1 finished on a freight train, never upgraded, ending with $15M cash.

The trigger: s1 was carrying a Cheese load whose only valid delivery city was **Dublin**. Dublin is a hybrid grid point — listed as `Type: "Small City"` in `configuration/gridPoints.json` but also one endpoint of the `Dublin_Liverpool` ferry (`configuration/ferryPoints.json`, cost 8M). s1 had built track to Liverpool (the other ferry endpoint at coord `(13,29)`); under game rules, the player who builds to a ferry port pays the full ferry cost and the partner endpoint is then accessible at no further cost. So s1's $79M of built track *was* genuinely connected to Dublin — no further build needed to deliver.

But `citiesOnNetwork` (computed by `NetworkContext.computeCitiesOnNetwork` at `NetworkContext.ts:189`) iterates only over segment endpoints in `network.nodes`. Dublin's coord `(10, 24)` is not a segment endpoint (the bot built to Liverpool, not to Dublin — the ferry crossing replaces the need to build the last leg). So `citiesOnNetwork.includes("Dublin") === false` even though the bot has functional access to Dublin.

`MovementPhasePlanner.A2` (`MovementPhasePlanner.ts:362`) gates the MoveTrain branch on `context.citiesOnNetwork.includes(targetCity)`. Dublin not in set → fall through to `stop_city_not_on_network` at line 429 → call A3.

`MovementPhasePlanner.A3` calls `computeBuildSegments` targeting Dublin. The pathfinder is internally ferry-aware (it knows about `Dublin_Liverpool`) and correctly determines no segments need to be built — Dublin is already reachable. Returns an empty segment array. The caller at line 468 treats `length === 0` as `build_dijkstra_failed`. Executor emits PassTurn.

Replanner re-runs. Bot is still carrying Cheese; the only valid delivery is Dublin; the trip planner correctly picks `carry:Cheese → deliver Dublin (payout 19M, NET +7M)` as the best route. Executor fails the same way. Livelock — same byte-for-byte composition trace from t20 through t61.

## Source

`logs/game-c990fa47-bfc1-4437-9fc3-f148034c32f6.ndjson`. Player s1 turns t17–t61. Discovered 2026-05-19. Player segments confirmed via `player_tracks` DB row (50 segments, $79M total, westernmost endpoints clustered at `(13–19, 29–34)` including Liverpool `(13,29)`, no segment touches Dublin `(10,24)` or anywhere on Ireland).

## Observed trace (s1)

| Period | turns | BuildTrack | MoveTrain | PassTurn | Deliveries |
|---|---:|---:|---:|---:|---:|
| t1–t17 (productive) | 17 | 7 | 11 | 0 | 3 |
| **t18–t61 (livelock after Cheese pickup)** | **44** | **0** | **0** | **43** | **0** |

s1 picks up Cheese on t19 at Holland, ends turn at `(20,38)`. From t20 onward, every turn:
1. Composition trace identical: `a2.terminationReason=stop_city_not_on_network`, `a3.terminationReason=build_dijkstra_failed`, `build.target=Dublin`, `build.cost=0`, `outputPlan=["PassTurn"]`.
2. `[stuck-route-abandon] no progress for N turns` fires after 3-turn windows.
3. Replanner picks `carry:124:Cheese → deliver Dublin, payout 19M, build 12M, 2 turns, NET 7M`.
4. PassTurn.

Same loop forever. Cash never drops below $15M (so this isn't cash-starvation), train never upgrades (no cash gain to spend), city count never advances past 4.

## Comparison to s2/s3 (same game, same logic)

| | s1 | s2 | s3 |
|---|---:|---:|---:|
| Deliveries | 3 | 16 | 17 |
| Earned | $44M | $369M | $318M |
| Final cash | $15M | $196M | $173M |
| Final train | freight | superfreight | superfreight |
| PassTurns | **43** | 0 | 0 |
| Ferry hard-rejects (informational, not blocking) | 2 | 14 | 2 |

s2 crossed ferries 14 times. The bug is not in ferry execution generally — it's specifically in *recognizing that the bot is already on the network's far side of a paid ferry*.

## Why this bug is silent for most ferry crossings

Most ferry-pair destinations in this map are pure ferry ports (Plymouth, Cherbourg, Stranraer, Dover, Calais, Portsmouth, etc.). For those, a delivery target city is reached by building track from the ferry port to the city — so the city's coord *is* a segment endpoint and `citiesOnNetwork` includes it.

Dublin (and Belfast via Stranraer) are the exceptions: they're hybrid city/ferry-port points. The ferry crossing terminates *at* the city. No further track is needed. `citiesOnNetwork` silently excludes them whenever the bot has the partner ferry port but not the hybrid city itself as a segment endpoint.

## Expected behavior

When the bot has built track to a ferry port, the partner ferry endpoint city should be considered on-network for the purposes of A2's `citiesOnNetwork.includes(targetCity)` gate. The bot should treat the delivery-at-Dublin route as a `MoveTrain` problem (cross the paid ferry and deliver), not a `BuildTrack` problem.

## Acceptance

- **AC1 — Dublin in citiesOnNetwork via paid ferry:** Reconstruct s1's t20 snapshot from `player_tracks` (50 segments including Liverpool at `(13,29)`). Assert `computeCitiesOnNetwork(network, gridPoints)` returns a set that includes `"Dublin"`.
- **AC2 — A2 picks MoveTrain for Dublin delivery:** Same fixture. Assert `MovementPhasePlanner` enters the MoveTrain branch at line 362 (no `stop_city_not_on_network` fall-through, no `build_dijkstra_failed`).
- **AC3 — full-game regression:** Replay s1's t20 snapshot for 10 turns. Assert the Cheese load is delivered, cash advances past $15M, and PassTurn is not emitted for any of those 10 turns.
- **AC4 — Belfast via Stranraer same fix:** Symmetric fixture with Belfast as delivery target and bot having track to Stranraer. Same assertions as AC1/AC2.
- **AC5 — non-ferry paths unaffected:** Existing test for `citiesOnNetwork` with no ferry crossings still passes — set contents unchanged when no ferry-paired destinations exist.

## Not in scope

- Trip planner cost estimator correctness for multi-ferry routes (separate concern).
- Drop-load escape mechanism (separate concern; this fix removes the need for it in the observed case).
- General ferry-execution issues in MoveTrain (existing 14× hard-rejects for s2 are informational and not the topic of this ticket).
- Behavior when the bot does not own the paid ferry (i.e., partner port is on another player's track) — that's a track-fee question, not reachability.

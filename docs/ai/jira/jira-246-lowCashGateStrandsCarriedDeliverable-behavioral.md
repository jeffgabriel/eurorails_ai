# JIRA-246 — Low-cash deliver-first gate suppresses build target but doesn't redirect executor, stranding a carried deliverable load (behavioral)

In post-JIRA-244 game `eb20489f-0900-416f-94cf-72c9f383269a`, player s1 emitted **16 PassTurn actions out of 74 turns**, with a 15-turn consecutive livelock from T16 through T31. The trigger is structurally distinct from JIRA-244: this is not a ferry-partner-city case, and `citiesOnNetwork` is correctly populated.

The trigger: at T16, s1 is at coord `(32, 45)` with $4M cash on a fast_freight train. s1 is **carrying a Wheat load whose matching demand card delivers at Berlin** — and Berlin is already on s1's network (s1 had been near Berlin before drifting south). The bot's active route was created earlier and its current stop is **pickup Cattle at Bern** (Switzerland) — Bern is NOT on s1's network. The route order is: pickup Cattle@Bern → deliver Wheat@Berlin → deliver Cattle@Berlin.

`MovementPhasePlanner.A2` sees the current stop's city (Bern) is not in `citiesOnNetwork` and falls through to A3 (build-target preview). A3 calls `resolveBuildTarget(activeRoute, context)` to pick a build target. `resolveBuildTarget` reaches the **JIRA-165 Fix 2 capital-allocation gate** (`src/server/services/ai/routeHelpers.ts:207-214`):

> "If the bot is carrying a load that can be delivered on-network AND is broke (<$5M), skip building so the executor advances to the deliverable stop for income first."

The gate fires (cash $4M < $5M, carrying Wheat, Wheat delivery city Berlin is on-network) and returns `null`. A3 records `terminationReason = no_build_target`. The executor has no build target and no movement target (A2 couldn't move toward Bern), so it emits `PassTurn`.

But the executor never advanced to the deliverable stop. A2 only ever consults the route's `currentStop` (the off-network Bern pickup), not later stops. The "deliver Wheat at Berlin" stop is index `currentStopIndex + 1` and sits behind the off-network pickup. Nothing redirects the executor past the pickup to the deliverable.

Replanner re-runs each turn. Bot is still carrying Wheat; the active route is intact; same gate fires; same `no_build_target`; same PassTurn. Loop runs from T16 to T31 (15 turns). At T31 the `stuck-route-abandon` heuristic finally tears down the active route (3-turn no-progress threshold + accumulated counter), the planner re-plans with a fresh hand, and the bot delivers Wheat at Berlin on T32 (cash $4 + payout → $28+ M).

## Source

`logs/game-eb20489f-0900-416f-94cf-72c9f383269a.ndjson`. Player s1 turns T16-T31. Discovered 2026-05-19 verifying JIRA-244's residual effect.

## Observed trace (s1)

| Period | turns | BuildTrack | MoveTrain | PassTurn | Deliveries |
|---|---:|---:|---:|---:|---:|
| T1-T15 (productive) | 15 | 5 | 8 | 0 | 2 |
| **T16-T31 (livelock after Wheat pickup, route fixated on Bern)** | **16** | **0** | **0** | **15** | **0** |
| T32-T74 (post-abandon recovery) | 43 | varies | varies | 1 | 3 |

Per-turn at T16 through T31:
1. Composition trace identical: `a2.terminationReason = stop_city_not_on_network` (Bern off-network), `a3.terminationReason = no_build_target` (gate fires), `build.target = null`, `outputPlan = ["PassTurn"]`.
2. `stuck-route-abandon` counter increments by 1 each turn.
3. Replanner does not run (route is not yet abandoned).
4. Action: PassTurn. Cash stays at $4M.

## Comparison to siblings (same game)

| | s1 | s2 | s3 |
|---|---:|---:|---:|
| Deliveries | 5 | 8 | 7 |
| PassTurns | **16** | 1 | 2 |
| Final cash | $188M | $259M | $175M |

s2/s3 did not hit this specific gate, presumably because their routes' current stops happened to be on-network or they had >$5M cash when carrying deliverables. The bug is asymmetric — it only fires when (a) cash < $5M, (b) carrying a deliverable-on-network load, AND (c) the active route's current stop is an off-network pickup.

## Expected behavior

When the low-cash gate determines that the bot should "deliver carried loads first," the executor must actually deliver the carried loads. Two acceptable outcomes:

- **Redirect path**: A2 should be invited to evaluate later stops in the active route, find the first deliverable-on-network stop, and route movement to it.
- **Abandon path**: The route should be marked abandoned immediately so the replanner can produce a fresh single-stop "carry → deliver" route.

What must NOT happen: the gate silently suppresses building, A2 has nothing to do, the executor emits PassTurn, and the bot waits 15 turns for an unrelated abandon heuristic to fire.

## Acceptance

- **AC1 — reconstruct T16 state**: Build a fixture matching s1's T16 snapshot (cash $4M, carrying Wheat, route stops = [pickup Cattle@Bern, deliver Wheat@Berlin, deliver Cattle@Berlin], Bern off-network, Berlin on-network). Assert: planner does NOT emit PassTurn. The bot either moves toward Berlin or abandons the route and replans.
- **AC2 — gate intent preserved**: Verify the original JIRA-165 Fix 2 intent ("don't spend the last $4M building when carrying a deliverable") still holds — the bot does not BuildTrack on this turn.
- **AC3 — full-game regression**: Replay s1's T16 snapshot for 5 turns. Assert: Wheat is delivered at Berlin within 3 turns, cash advances past $5M, no PassTurn in the window.
- **AC4 — non-deliverable case unaffected**: Same setup but with no deliverable-on-network demand. Assert: gate does not fire; A3 proceeds as before.
- **AC5 — sufficient-cash case unaffected**: Same setup but cash $10M. Gate does not fire; existing A3 build behavior holds.

## Not in scope

- The JIRA-247 `origin_is_current_position` failure mode (separate ticket).
- General stuck-route-abandon heuristic tuning (existing; this fix removes the need for it to fire in the observed case).
- Re-architecting A2's stop-iteration order (intentionally bounded — only pickup→deliver pairs at the current stop).

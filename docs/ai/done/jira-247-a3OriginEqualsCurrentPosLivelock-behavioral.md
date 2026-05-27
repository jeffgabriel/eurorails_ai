# JIRA-247 — A3 livelocks when `computeBuildSegments` returns a segment whose origin equals the bot's current position (behavioral)

In post-JIRA-244 game `dac9a541-2c9e-42f4-852f-159db1c32c1a`, player s1 emitted 3 PassTurns and accumulated a 35-turn `stuck-route-abandon` counter on the same Goteborg→Stockholm build target. The trigger is not a ferry case and not the JIRA-246 low-cash deliver-first gate.

The trigger: at T36, s1 has just delivered a load and is positioned at the Goteborg milepost (coord that is the closest point on its network to the next required pickup at Stockholm). The active route's next stop is Stockholm, which is NOT on s1's network. A2 falls through to A3 (build-target preview).

A3 calls `computeBuildSegments` with the target Stockholm. The pathfinder finds a build path. Critically, the **first segment in the returned array has `from = Goteborg`, which is exactly where the bot is standing.** `computeBuildSegments` correctly computes the cheapest path; the path happens to start at the bot's current position because Goteborg is the network's eastern frontier.

`MovementPhasePlanner.A3` at lines 482-491 inspects the first segment's `from` coord. If it equals the bot's current position, it sets `trace.a3.terminationReason = 'origin_is_current_position'` and falls through to `break` (line 524) — emitting PassTurn.

The check was originally a guard to avoid the "move to where you already are" no-op when A3 tries to move the bot to the build origin. But it does NOT also recognize "you're at the origin → just start building from here in Phase B." Phase B (BuildTrack composition) runs anyway in subsequent code paths, but in this trace the executor breaks out before it runs, returning a `MoveTrain`-only plan that is empty + no build + no PassTurn signal → PassTurn fallback.

Replanner re-runs. Same active route, same Goteborg position, same `computeBuildSegments` result, same `origin_is_current_position` check, same PassTurn. The `stuck-route-abandon` counter advances; eventually (after 3-turn no-progress windows) the active route is torn down, but the counter is observably 35 turns at one point, indicating extended periods of the same livelock.

## Source

`logs/game-dac9a541-2c9e-42f4-852f-159db1c32c1a.ndjson`. Player s1 turns T36, T71 (two distinct fires of the same failure mode). Discovered 2026-05-19 verifying JIRA-244's residual effect.

## Observed trace (s1 T36)

| Field | Value |
|---|---|
| Position | Goteborg coord |
| Active route current stop | pickup at Stockholm (off-network) |
| Cash | $98M (plenty — not a JIRA-246 case) |
| `a2.terminationReason` | `stop_city_not_on_network` |
| `a3.terminationReason` | `origin_is_current_position` |
| `build.target` | Stockholm |
| `build.cost` | 0 (Phase B never composed) |
| `outputPlan` | `[]` → PassTurn (default) |
| `stuck-route-abandon` | counter incrementing |

Same trace replays at T71 (different position pair, same termination reason).

## Expected behavior

When `computeBuildSegments` returns a non-empty path whose first segment starts at the bot's current position, A3 must recognize that **building can proceed directly from the bot's current position** — no preliminary MoveTrain is needed. The composition should fall through to Phase B (BuildTrack) with `build.target = <route stop city>` and `build.origin = currentPos`, not emit PassTurn.

Equivalent acceptable outcome: A3 sets `terminationReason = 'a3_origin_is_current_pos_proceed_to_build'` and lets the outer composition loop continue to Phase B, which will pick up the build from `currentPos`.

What must NOT happen: the executor breaks out of A2/A3 with an empty plan, defaulting to PassTurn, and looping on the same target for tens of turns.

## Acceptance

- **AC1 — reconstruct T36 state**: Build a fixture matching s1's T36 snapshot (bot at Goteborg, active route stop = Stockholm pickup, network is Goteborg + east-coast Swedish track but not yet Stockholm). Mock `computeBuildSegments` to return a path whose first segment's `from` coord equals the bot's position. Assert: planner does NOT emit PassTurn.
- **AC2 — Phase B composes the build**: Same fixture. Assert: composition trace shows `build.target = Stockholm`, `build.cost > 0`, `outputPlan` contains a `BuildTrack` action.
- **AC3 — full-game regression**: Replay s1's T36 snapshot for 5 turns. Assert: BuildTrack is emitted at least once, network advances toward Stockholm, no PassTurn in the window.
- **AC4 — JIRA-244 Fix B path still works**: Existing test for `a3_target_already_reachable` (empty-result case) still passes — that path is orthogonal.
- **AC5 — true no-op move case unaffected**: When `computeBuildSegments` returns a path whose origin coord is a peer milepost the bot would need to move to (not currentPos), the existing MoveTrain branch (lines 492-517) still fires.

## Not in scope

- The JIRA-246 low-cash gate (separate ticket).
- Ferry-related A3 logic (covered by JIRA-244).
- Refactoring computeBuildSegments to return an "already at origin" flag (a smaller in-A3 check is preferable to changing the pathfinder contract).

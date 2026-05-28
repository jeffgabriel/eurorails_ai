# JIRA-266 — Phase B victory-build trigger gates on `cash >= $230M` instead of `gameState=End`; bot leaves cheapest unconnected major cities unbuilt for 7–13 turns after end-game latches at $200M, then has to do a build burst that drains cash back below the victory threshold and another 6–10 turns of grinding to refill (behavioral)

In games `46e424ad`, `76de7d99`, and `854661e5`, the winning bot entered `gameState=end` (cash crossed $200M) with `majorsGap > 0`, then ran deliveries for 7–13 turns with **zero connector builds** despite having $20M/turn of unused build budget. Once cash crossed the existing $230M `VICTORY_BUILD_TRIGGER_M` threshold (typically via a single large delivery), the bot finally started building connectors — but the rapid build burst dropped cash back below the $250M victory threshold, requiring another 6–10 turns of cash grinding to clinch. The defect is structurally identical to the one documented in `routeHelpers.ts:30-36` ("winner in game 38e92b14 sat at 220M cash with 4 cities for ~8 turns, never triggering victory builds because the threshold was 250M") — but the $250M → $230M tuning didn't close the gap. The persistent end-game latch fires at $200M; the build-engagement threshold is still $30M too high.

## Source

`logs/game-46e424ad-9090-4d6f-ab44-918b1fdf70d7.ndjson` (run with JIRA-265 endGame trace), plus `logs/game-76de7d99-48aa-464d-a977-d8908a2e551c.ndjson` and `logs/game-854661e5-87f1-4f20-a89a-695896c9434a.ndjson` for corroboration. Discovered 2026-05-26 — visible via the new per-turn `composition.endGame` field added in JIRA-265 Layer 1.

## Plain-English walkthrough of the current logic

`BuildPhasePlanner.run` calls `resolveBuildTarget(activeRoute, context)` once per turn (`BuildPhasePlanner.ts:217`) to decide what to build toward. `resolveBuildTarget` at `routeHelpers.ts:199` has two branches:

1. **Victory-build branch** (lines 211–213). Fires when:
   - `context.money >= VICTORY_BUILD_TRIGGER_M` (currently `$230M`), AND
   - `connectedMajorCities.length < VICTORY_CITY_COUNT` (7).

   When fired, it picks the cheapest unconnected major as the build target and returns it. Phase B then lays segments toward that city this turn (up to the $20M per-turn budget cap).

2. **Route-based branch** (else path). Selects a build target derived from the active route's next stop (e.g. building toward a pickup or delivery destination on the route).

When neither branch fires, `resolveBuildTarget` returns `null` → `BuildPhasePlanner.ts:221` sets `trace.build.skipped = true` and no track is laid this turn.

The `gameState` field is **not consulted by `resolveBuildTarget`**. The persistent end-game latch from JIRA-241 (cash > $200M, latched, sticky) and the `memory.endGameLocked` flag from JIRA-265 Layer 2 both exist — but `resolveBuildTarget` uses the older `money >= 230` cash comparison as its only end-game-aware gate.

## Cross-game evidence

| Game | Winner | Latch (gameState=end first fires) | Cash at latch | Majors at latch | Idle-build window before victory-build engages | Win turn | Total latch→win | Counterfactual savings |
|---|---|---|---|---|---|---|---|---|
| `46e424ad` | s3 | T74 | $207M | 4/7 (gap 3) | **11 turns** (T74–T84: 1 route-driven build of $4M total) | T98 | 24 turns | ~11 turns |
| `76de7d99` | s3 | T83 | $204M | 4/7 (gap 3) | **13 turns** (T83–T95: zero builds, 1 PassTurn, 2 DiscardHand) | T112 | 29 turns | ~12 turns |
| `854661e5` | s2 | T72 | $201M | 5/7 (gap 2) | **7 turns** (T72–T78: zero builds) | T89 | 17 turns | ~7 turns |
| `0c08d484` | bot2 | T86 | ~$228M | **7/7 (gap 0)** | — (no majors to build; bot pre-built in mid-game) | T96 | 10 turns | 0 (no defect here) |

The first 3 games all show: latch fires at cash ~$200–207M, victory-build trigger doesn't engage until ~$230M, idle window persists until a single delivery pushes cash over the threshold.

## Per-turn evidence — 46e424ad s3 T74–T88 (via JIRA-265 endGame trace)

```
T74 cash=207 majors=4 endGameLocked=true cashGap=43 majorsGap=3 buildTarget=null  skipped=true
T75 cash=207 majors=4 endGameLocked=true cashGap=43 majorsGap=3 buildTarget=null  skipped=true
T76 cash=207 majors=4 endGameLocked=true cashGap=43 majorsGap=3 buildTarget=null  skipped=true
T77 cash=203 majors=4 endGameLocked=true cashGap=43 majorsGap=3 buildTarget=Budapest 2seg/$4M  (route-derived, NOT a connector)
T78-T84 (7 turns) cash=203 majors=4 endGameLocked=true cashGap=43-47 majorsGap=3 buildTarget=null  skipped=true
T85 cash=257 majors=4 endGameLocked=true cashGap=0  majorsGap=3 buildTarget=Ruhr  2seg/$6M  (cash NOW above $230M → trigger fires)
T86 cash=248 majors=5 buildTarget=Berlin 3seg/$9M
T87 cash=236 majors=6 buildTarget=Paris  8seg/$12M  (one turn for an 8-segment spur — budget cap is NOT the constraint)
T88 cash=229 majors=7 buildTarget=Frankfurt 4seg/$7M
```

`cheapestConnectors=[Ruhr($6M), Berlin($9M), Paris($10M-$12M)]` was visible in `endGame.cheapestConnectors` on **every** turn from T74 onward. The bot knew about Ruhr — it just wasn't allowed to start building until cash hit $230M.

The T87 single-turn 8-segment build proves the per-turn build budget is not the constraint. Connectors can be completed in 1–2 dense turns each.

## Why this is the same defect that JIRA-265's Layer 2 latch was meant to fix

JIRA-265 Layer 2 correctly moved the `endGameLocked` latch to `ContextBuilder` so it engages every turn (not just replan turns). But the consumer that should drive **behavior** off that latch — Phase B's victory-build decision — still gates on a cash threshold rather than the latch. So the latch is observably correct (`endGameLocked=true` on every turn from T74) but no downstream code uses it to engage connector building. JIRA-265 surfaced the symptom; this ticket fixes its proximate cause.

## What the algorithm should do

Per the user's "math should be right, no tuning knobs" framing applied to end-game pacing:

- The bot enters end-game when cash > $200M (the persistent latch from JIRA-241).
- From that moment on, the bot's strategic priority is to close `majorsGap` and `cashGap` simultaneously, using its $20M/turn build budget to lay connector segments while deliveries refill cash.
- The current $230M trigger is a tuning attempt that fails when the bot enters end-game between $200M and $230M and stays there for many turns without a large enough delivery to push it over the threshold.
- The natural gate is `gameState === End` (equivalently `memory.endGameLocked === true`). Once the latch fires, victory-build engagement should follow on the next turn — not wait for cash to coincidentally rise to a hardcoded threshold.

The fix is structural, not a tuning change. No new code path; just the right condition on an existing branch.

## Expected behavior after the fix

For each affected game, replaying with the fix would produce:

- **46e424ad**: T74 Phase B picks Ruhr as buildTarget (cheapestConnectors[0]). T74–T76 lay Ruhr+Berlin in 1–2 turns. T75–T78 finish Paris. Cash dips to ~$176M (still well above $0 floor; end-game stays latched-sticky). T85's $54M delivery → cash $230M. T87–T88 finish the route → cash $258M → **WIN T87**. Saving 11 turns.
- **76de7d99**: T83 Phase B picks Kobenhavn (cheapest at $2M). T83–T90 incrementally complete Kobenhavn, Wien, Torino, Paris, London. T95's delivery + ongoing route income → **WIN ~T100**. Saving 12 turns.
- **854661e5**: T72 Phase B picks Paris. T72–T74 complete Paris + London (~12 segments, ~$23M over 2 turns). T78 delivery → cash ~$225M. T82–T84 finish → **WIN ~T82**. Saving 7 turns.
- **0c08d484**: no behavioral change. `majorsGap === 0` at latch → `isVictoryEligible === false` → existing route-based branch runs unchanged.

## Not in scope (cross-game observation; behavioral only)

This is 3 corroborating observations across games with different winners, players, and map regions. The fix shape proposed here is directly motivated by the existing comment at `routeHelpers.ts:30–36` (documenting the same defect family) and the JIRA-265 visibility data. Broader changes to connector ordering (e.g. proximity to bot's travel path), build-per-turn pacing, or interaction with route-based builds are out of scope until the simpler trigger fix lands and the post-fix logs are reviewed.

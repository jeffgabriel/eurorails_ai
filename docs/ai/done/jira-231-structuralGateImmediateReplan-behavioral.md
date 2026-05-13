# JIRA-231 — TripPlanner picks demand cards whose supply/delivery city is structurally unreachable (behavioral)

## Source

Game `32964f24-ab5a-420f-a9d5-35c3952439da`, player **S1** (S2 and s3 unaffected). Two identical incidents in one game; both caused by the same demand card. The "fix" the bot found each time was PassTurn → DiscardHand the following turn, costing two turns per occurrence.

## The structural truth

`configuration/gridPoints.json` defines **Firenze** as a **Small City** at `GridX=44, GridY=48`, which in the bot's `(row, col)` system is **(48, 44)**.

In game `32964f24`, two other players have built track to Firenze. Small-city cap is **2 players total**. Player S1 cannot ever build to Firenze — adding S1's entry would push total players to 3, violating `CITY_ENTRY_LIMIT`. This is a **permanent** state for the rest of this game.

`TurnValidator.computeSaturatedCityKeys(snapshot)` correctly identifies (48, 44) as saturated for S1 — the validator uses it, and `computeBuildSegments` (the build-path Dijkstra) excludes it when called via `BuildRouteResolver`.

## Observed behavior

Despite (48, 44) being known-saturated for S1, the TripPlanner's `demandRanking` includes:

**Turn 20:**
| Rank | Demand | Score | trackCostToSupply | Notes |
|---|---|---|---|---|
| **1** | **Marble @ Firenze → Hamburg** | **4.7** | **7** | **Firenze is saturated for S1 — unreachable.** |
| 2 | Imports @ Hamburg → Lodz | 1.87 | 0 | Hamburg on-network, feasible. |
| 3 | Cheese @ Arhus → Zagreb | 0.15 | 12 | Feasible. |
| … | … | … | … | … |

**Turn 48:**
| Rank | Demand | Score | trackCostToSupply | Notes |
|---|---|---|---|---|
| **1** | **Marble @ Firenze → Ruhr** | (rank-1, paired with Cheese@Wroclaw) | **7** | **Firenze is saturated for S1.** |
| 2-N | (multiple non-Firenze demands) | | | All feasible. |

The TripPlanner picks the rank-1 (Firenze) demand both times. The downstream sequence each time:

1. `TripPlanner` produces an active route with `pickup Marble @ Firenze` as stop 0.
2. `MovementPhasePlanner` reports `stop_city_not_on_network` (Firenze isn't on S1's track).
3. `BuildPhasePlanner` calls the build resolver toward Firenze; resolver returns a path whose final segment terminates at (48, 44).
4. `TurnValidator.checkCityEntryLimit` rejects: `Cannot build into small city at (48,44) — 2 player limit reached`.
5. Phase B is stripped. The JIRA-203 lockup branch logs `phaseb_stripped_passturn`. Bot emits `PassTurn`.
6. Next turn: same demand selected (still rank-1), same gate fires, same position. The "consecutive identical strip" predicate triggers `lockup_route_abandoned` → `DiscardHand`.
7. The bot re-draws three demand cards. Two turns lost.

## Why this matters

- **The recovery path is firing correctly. The root cause is upstream.** The `DemandEngine.computeAllDemandContexts` function — which produces the contexts the TripPlanner ranks over — does not consult `saturatedCityKeys`. So demands whose supply or delivery city is structurally unreachable for the bot still get scored normally based on `estimatedTrackCostToSupply` / `estimatedTrackCostToDelivery`, as if the bot could build into them.
- **Marble@Firenze for S1 in this game is permanently dead.** Both turn 20 and turn 48 picked the same dead demand. Any future turn S1 holds a Marble→Firenze card will repeat the cycle — discard, redraw, possibly draw it again. The bot has no mechanism to learn that Firenze is unreachable.
- **DiscardHand is the wrong recovery for this failure mode.** Discarding throws away the other two cards in the hand, which were perfectly valid. The right recovery is "pick a different demand from the same hand."
- **The fix is in the demand layer, not the recovery layer.** Filter Firenze-as-supply-city out of the demand contexts at TripPlanner input time and the entire PassTurn → DiscardHand cycle vanishes. The recovery branches in `AIStrategyEngine.ts:416-451` need no changes.

## Acceptance criteria

- **AC1** `DemandEngine` (or the layer that produces `DemandContext[]` for the TripPlanner) MUST consult `TurnValidator.computeSaturatedCityKeys(snapshot)` when scoring demands. A demand is **infeasible for the bot** when:
  - Its `supplyCity` resolves to a milepost in `saturatedCityKeys` AND that milepost is NOT already on the bot's network, OR
  - Its `deliveryCity` resolves to a milepost in `saturatedCityKeys` AND that milepost is NOT already on the bot's network.
- **AC2** Infeasible demands MUST be excluded from `demandRanking` entirely (not ranked low — excluded). They MUST NOT appear in the bot's plan choices unless saturation state changes.
- **AC3** When all demands in the hand are infeasible, the TripPlanner MUST report "no feasible route" and the bot MUST emit `DiscardHand` directly. The wasted PassTurn turn observed in this game MUST NOT occur.
- **AC4** Replay turn 20 and turn 48 from game `32964f24`:
  - Turn 20: `demandRanking` excludes Marble@Firenze → rank-1 becomes Imports@Hamburg→Lodz. Bot plans a productive turn (move/build toward Hamburg or pickup Imports if Hamburg is on-network).
  - Turn 48: `demandRanking` excludes Marble@Firenze→Ruhr → rank-1 becomes the next viable demand. Bot plans a productive turn.
  - In neither turn does the bot emit `PassTurn` or `DiscardHand`.
- **AC5** Infeasibility is **dynamic**. If an opponent removes track from a saturated city later in the game (changing its saturation state), the same demand re-enters the ranking. The check is per-turn against the current snapshot — not memoized.
- **AC6** No regression in existing tests for `DemandEngine`, `TripPlanner`, or the JIRA-203 strip/lockup branch.

## Out of scope

- Changing `CITY_ENTRY_LIMIT` enforcement.
- Tightening the saturated-city build-pathfinder exclusion. (Tracked in technical doc as related-but-secondary plumbing.)
- Stripping out the JIRA-203 strip/lockup branch. It should still fire for genuine edge cases (e.g., a demand that becomes infeasible mid-route due to an opponent's mid-turn build); this fix just removes the most common upstream cause.

## Severity

**High** — Observed twice in one game on one player from the same demand card. Reproduces deterministically any time the bot holds a demand whose supply or delivery city is a small/medium city already at the player cap. As more games are played with more players competing for small-city entries, this failure mode increases in frequency. Each occurrence costs 2 turns plus a fresh-card draw.

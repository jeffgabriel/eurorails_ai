# JIRA-265 — End-game state has no per-turn NDJSON visibility; the `memory.endGameLocked` ranking carve-out doesn't appear to engage during execution turns; in game 086fa2ce s1, `gameState=end` correctly latched at T61 but the bot took 18 more turns to win, with no observable end-game logic firing for 6 of the 7 final turns (behavioral)

In game `086fa2ce-a6c9-4a88-b91a-9653fc7fdcf9` (all-bot Haiku match), player s1 (superfreight) reached cash > $200M at T61 and `gameState=end` correctly latched. From that turn through T79 (the winning turn), the per-turn NDJSON log surfaces almost no information about (a) what the bot needs to win, (b) what its plan is to get there, or (c) whether the existing end-game ranking carve-out (`memory.endGameLocked` per JIRA-255) is engaged. The displayed `gamePhase` field continues to show `Mid Game` even at cash $255M because the display computation is dominated by major-city count rather than the latched end-game state. Between T72 (7 majors connected, cash $218M, gap of $32M to win) and T79 (cash $259M, declared), the bot executed a `[route-executor]` route for 6 turns with no end-game-specific replan visible — and the one winning replan at T79 chose a `triple-3fresh` with **NET aggregate score of −0.33 M/turn over 17 turns**, which is the antithesis of "win the game quickly".

## Source

`logs/game-086fa2ce-a6c9-4a88-b91a-9653fc7fdcf9.ndjson`, player s1 turns T60–T79. Discovered 2026-05-25 — user-reported.

## End-game phase concepts in this codebase

There are **three independent "end-game" mechanisms** and they don't align. Understanding which one fires when is a prerequisite for any end-game diagnosis.

| Mechanism | Source file:fn | Trigger | What it gates |
|---|---|---|---|
| `context.gameState: 'end'` | `ContextBuilder.computeGameState` (via `victoryRules.ts:57`) | cash > $200M (latches forever) OR turn ≥ 26 (mid) / ≥ 4 (early) | `findFinalVictoryRoute` call at `AIStrategyEngine.ts:302`; `applyEndStateScoring` entry condition at `DeterministicTripPlanner.ts:1886` |
| `context.gamePhase: 'Mid Game'/'Late Game'/'Victory Imminent'` | `NetworkContext.computePhase` | Hybrid majors+cash thresholds: 6+ majors AND $230, or 5+ AND $250, or 5+ AND $150, or 3+ majors / $80M | Display only (NDJSON `.gamePhase` field, LLM prompt text) |
| `memory.endGameLocked: boolean` | `DeterministicTripPlanner.ts:1671-1684` (inside `planTripDeterministic`) | cash > $200M OR `classifyGamePhase==='late'` (5+ majors OR turn ≥ 80) | `cheapPrune` turn-cap exemption (`:1009`); win-completer-first ranking (`:1897`); `endGameContext` reasoning annotation (`:1972`) |

`gameState=end` and `endGameLocked` use the same `$200M` trigger but live in different objects and update at different times. `gamePhase` uses entirely different thresholds and is just a UI label.

## Trace — s1, game 086fa2ce, T60–T79

| Turn | cash | gameState | gamePhase | majors | victoryCheck | endGameLocked (NDJSON) | reasoning highlight |
|------|------|-----------|-----------|--------|--------------|------------------------|---------------------|
| T60 | 222 | mid | Mid Game | 4 (Milano, Ruhr, Berlin, London) | insufficient-funds | null | — |
| T61 | 222 | **end** | Mid Game | 4 | insufficient-funds | null | `gameState` latched here |
| T62–T64 | 222 | end | Mid Game | 4 | insufficient-funds | null | `[route-executor]` |
| T65 | 255 | end | Mid Game | 4 | **too-few-cities** | null | cash crossed $250M; needs 3 majors |
| T66–T67 | 255 | end | Mid Game | 4 | too-few-cities | null | `[route-executor]` |
| T68 | 247 | end | Mid Game | 4 | insufficient-funds | null | BuildTrack — spent $8M |
| T69 | 247 | end | Late Game | 5 (Paris connected) | insufficient-funds | null | — |
| T70 | 240 | end | Late Game | 5 | insufficient-funds | null | BuildTrack — spent $7M |
| T71 | 227 | end | Victory Imminent | 6 (Holland connected) | insufficient-funds | null | BuildTrack — spent $13M |
| T72 | 218 | end | Late Game | 7 (Wien connected) | insufficient-funds | null | BuildTrack — spent $9M; **7 majors achieved, +$32M cash needed** |
| T73 | 218 | end | Late Game | 7 | insufficient-funds | null | `[route-executor]` |
| T74 | 218 | end | Late Game | 7 | insufficient-funds | null | `[route-executor]` |
| T75 | 237 | end | Late Game | 7 | insufficient-funds | null | `[route-executor]` + replan: `[final-victory] Steel→Warszawa, Copper→Antwerpen, turns=15, build=30M, payout=38M, cash@victory=255M, majors@victory=7` — but routesMatch suppressed override (existing 4-stop route shared first stop) |
| T76 | 228 | end | Victory Imminent | 7 | insufficient-funds | null | new route `[deliver:Cardiff(Copper)]` (post-delivery replan picked Copper→Cardiff over Copper→Antwerpen) |
| T77 | 228 | end | Late Game | 7 | insufficient-funds | null | `[route-executor]` |
| T78 | 228 | end | Late Game | 7 | insufficient-funds | null | `[route-executor]` |
| T79 | 259 | end | Late Game | 7 | **declared** | null | delivered Copper@Cardiff (+$31M) → won. Post-delivery replan picked `triple:Imports+Cheese+Copper:3f-ABC`, **NET 36M over 17 turns, aggregate −0.33 M/turn** |

## Observable problems

1. **`endGameLocked` is null in every turn-log entry.** The flag is set inside `planTripDeterministic` (line 1679), which runs only on replan turns (`no-active-route` or post-delivery). For T60–T78 most turns are pure `[route-executor]` execution — no replan, no planTripDeterministic call, no chance to set the flag. `GameLogger` reads it from somewhere that's always seeing the pre-planner value. Either the lock latch is in the wrong place, or the log capture is in the wrong place, or both.

2. **No per-turn visibility of `cashGap`, `majorsGap`, full win cost, or victory-route projection.** The `victoryCheck.outcome` field tells you the result (insufficient-funds / too-few-cities / declared) but not the deltas or the cost to close them. The only places the deltas appear in the NDJSON are:
   - Inside `[final-victory]` reasoning strings, which only emit when `findFinalVictoryRoute` returns a non-null route AND the override applies.
   - Inside `End-game: ...` reasoning annotations from `synthesizeReasoning`, which only emit when `endGameLocked=true` AND `planTripDeterministic` runs (per #1, rarely).

   Result: from the NDJSON alone you cannot answer "at T73, how much cash and how many majors does the bot need, and what's its plan to get them?"

3. **`gamePhase` display field disagrees with `gameState` at the relevant junctures.** At T65 cash=$255M (over victory threshold!) but gamePhase shows "Mid Game" because s1 only has 4 majors. The user sees `Mid Game | Cash: 255M` and reasonably concludes the bot doesn't understand the game state.

4. **End-game ranking carve-out did not fire for T76–T78 turn-execution.** The Cardiff route was picked by a post-delivery replan at T75/T76. With endGameLocked engaged, win-completer ranking (line 1897) sorts cash-completing candidates first by fewest turns. The Cardiff route did complete the win ($228 + $31 = $259), so it WAS win-completing — but the bot then spent T76, T77, T78 traveling to Cardiff (3 turns of no payout) when there was already $228M cash and the closest delivery would have clinched. A win-completer ranking by **fewest turns to completion** would have preferred any deliverable load with a destination 1–2 turns away over a 3-turn trip to Cardiff. We can't tell from the log whether the win-completer ranking ran at all (endGameLocked null).

5. **The T79 winning-turn replan picked a NEGATIVE-aggregate plan.** `triple:Imports+Cheese+Copper, NET 36M over 17 turns, aggregate −0.33 M/turn`. The plan starts with three pickup stops in Antwerpen, Bern, Wroclaw — geographically scattered. In normal play the scorer would never pick this. In end-game play (with endGameLocked engaged) the win-completer-first rule should have picked something different. Whatever fired here, it didn't optimize for victory. The fact that s1 won this turn is incidental — the planner's choice was a fall-back, not a deliberate victory plan.

## Expected behavior

For every turn where `gameState==='end'`, the NDJSON entry should expose a structured `endGame` object (or equivalent flat fields) with at minimum:

- `endGameLocked: boolean` — current value of `memory.endGameLocked` (after this turn's update)
- `cashGap: number` — `max(0, 250 - cash)` in ECU M
- `majorsGap: number` — `max(0, 7 - connectedMajorCities.length)`
- `cheapestConnectors: Array<{cityName, costM}>` — the cheapest `majorsGap` unconnected majors needed to win
- `fullWinCostM: number` — `cashGap + sum(cheapestConnectors.costM)`
- `victoryRouteProjection: { stops?, turns?, buildM?, payoutM?, cashAtVictory?, majorsAtVictory? } | { skipReason: 'no_demands' | 'victory_met' | 'no_feasible_demands' | 'no_route_covers_gap' }` — the per-turn output of `findFinalVictoryRoute`, whether or not the override fires
- `activePlanProjection: { willClinch: boolean, projectedCash?, projectedMajors?, turnsRemaining? }` — whether the bot's current `activeRoute` (if any) will clinch on completion, and the projected end-state if so

A reader of the NDJSON should be able to answer per turn: "is the bot in end-game state? what does it need? what's its plan to get there? is that plan actually going to win, and when?"

Beyond visibility, two behavioral observations need root-cause work:

- (5) above: the end-game ranking carve-out either didn't fire or didn't favor faster-clinch routes. With (1) fixed (visibility), the next investigation can answer "why".
- The `gamePhase` display field should align with `gameState` once the latch fires. At minimum, `gamePhase` should never show "Mid Game" when `gameState==='end'`.

## Not in scope (single-game observation; visibility-first)

This is one observation in one game. No generalization beyond "the per-turn NDJSON lacks end-game visibility" and "`endGameLocked` doesn't visibly engage on execution turns". Broader scoring or ranking changes require corroborating observations across games after the visibility fix lands and the operator can see what's actually happening.

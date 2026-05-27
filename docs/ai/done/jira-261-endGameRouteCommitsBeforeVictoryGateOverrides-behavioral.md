# JIRA-261 — End-game route lock-in: deterministic planner commits s3 to a 5-stop continental round-trip after gameState transitions to `end`, and `findFinalVictoryRoute` never overrides during the 8-turn execution window. s2 wins instead (behavioral)

In game `8350cffa-d357-45b4-9bbb-eafeefd60a55` (all-bot Haiku + s1/s2/s3 match), player s3 entered `gameState: end` at T66 with cash $202M and 3 connected major cities (Ruhr, Berlin, Wien). At T67 a replan fired and the `DeterministicTripPlanner` selected `single-fresh Ham@Warszawa → Glasgow` (NET 39M, aggregate 3.00 M/turn, chained with `single:18:Oil-sup:Beograd`). That commitment locked s3 into a 5-stop sequence that took until T75 to deliver the first leg. During the T67–T74 window, `findFinalVictoryRoute` (JIRA-245) — which runs at the top of every turn — never overrode the activeRoute, even though gameState was `end` throughout. s2 eventually won at T83 with 7 connected major cities; s3 reached 6 cities at T80 and ran out of time.

## Source

`logs/game-8350cffa-d357-45b4-9bbb-eafeefd60a55.ndjson`, player s3 turns T66–T83 (game-ending span). Discovered 2026-05-23 — user-reported.

## Observed trace — s3

| Turn | action | cash | majors | gameState | reasoning highlight |
|------|--------|------|--------|-----------|---------------------|
| T65 | MoveTrain | 202 | 3 | mid | replan: `pair:51-Oil+18-Oil` chosen |
| T66 | MoveTrain | 202 | 3 | **end** | `[route-executor] stop 1/3, phase=build` |
| T67 | MoveTrain | 223 | 3 | end | replan: **`single:35:Ham-sup:Warszawa` chosen** — single-fresh, NET 39M, aggregate 3.00 M/turn, chained with `single:18:Oil-sup:Beograd` |
| T68–T74 | MoveTrain | 223 | 3 | end | `[route-executor] stop N/4, phase=travel` — bot traveling to Britain via Warszawa pickup |
| T75 | BuildTrack | 260 | 3 (Paris added next turn) | end | post-delivery replan: **`[final-victory] Ham→Glasgow, Oil→Hamburg, turns=17, build=28M, payout=65M, cash@victory=260M, majors@victory=7`** |
| T76–T80 | BuildTrack/Move | 260→250 | 4→6 (London + Madrid + Paris connectors) | end → late | victory build-out continues |
| T80 | BuildTrack | 250 | 6 | late | victoryCheck: `too-few-cities` (need 7) |
| T83 | — | — | — | — | **s2 wins** with 7 cities (Paris, Holland, Milano, Ruhr, Berlin, London, Wien), netWorth $259M |

## Root cause — verified via diagnostic reproduction

`findFinalVictoryRoute` **IS firing and returning a route at every turn** in `end` state. A captured-state reproduction (constructing a WorldSnapshot+GameContext approximating s3's T67/T74/T75 inputs and calling the function directly) confirms:

| Turn | findFinalVictoryRoute fires? | Returned route includes London? |
|------|------------------------------|---------------------------------|
| T67 (cash 223, Ham not yet carried) | YES | YES — `pickup@Warszawa → deliver@Glasgow → pickup@Sevilla → deliver@London → pickup@Beograd → deliver@Hamburg` (turns=13, build=66M, payout=99M, cashAtVictory=256M, majorsAtVictory=7) |
| T74 (cash 223, Ham carried) | YES | YES — `deliver@Glasgow → pickup@Sevilla → deliver@London → pickup@Beograd → deliver@Hamburg` (turns=10, build=62M, payout=99M) |
| T75 (post Ham delivery, cash 260) | YES | YES — `pickup@Sevilla → deliver@London → pickup@Beograd → deliver@Hamburg → pickup@Aberdeen → deliver@Zurich` (turns=14, build=82M, payout=94M) |

So the function works. The bug is the **idempotency check at `AIStrategyEngine.ts:294-298`** that suppresses the override:

```ts
const alreadyTargeted =
  currentStop?.action === firstStop.action &&
  currentStop.loadType === firstStop.loadType &&
  currentStop.city === firstStop.city;
if (!alreadyTargeted) {
  activeRoute = { ... finalVictoryRoute ... };
}
```

At T68 onwards (after PostDeliveryReplanner at T67 set the 4-stop Ham+Oil chain via DeterministicTripPlanner):
- Existing route's `currentStop`: `pickup Ham@Warszawa`
- `findFinalVictoryRoute`'s `firstStop`: `pickup Ham@Warszawa`
- → `alreadyTargeted = true` → override **suppressed**

The two routes share their first stop but diverge after: the existing route is `[Ham@Warszawa, Ham@Glasgow, Oil@Beograd, Oil@Hamburg]` (4 stops); the victory route is `[Ham@Warszawa, Ham@Glasgow, Sevilla, London, Beograd, Hamburg]` (6 stops) — adding the critical Oranges→London leg that connects the 4th-of-7 major needed for victory. The idempotency check sees only the matching first stop and concludes the routes are "the same", so the longer victory-converging route never replaces the shorter income-only route.

The "[final-victory]" tag appears at T75 because the existing route's currentStopIndex finally advanced past stop 0 (Ham picked up at T67-T68, then bot completed Ham delivery somewhere around T75); at that point the existing route's currentStop differs from the victory route's firstStop, the idempotency check fails (correctly), and the override fires.

## Expected behavior

The idempotency check should suppress the override only when the proposed victory route is **substantively the same plan** as the existing activeRoute, not when only the first stop happens to match. Candidate semantics:

- **Suppress** when the proposed route is a strict prefix of the existing route (no new actions added).
- **Suppress** when the proposed route's full stops sequence equals the existing route's remaining stops (modulo currentStopIndex).
- **Replace** when the proposed route adds stops the existing route doesn't have (e.g., a London leg), even if the first stop matches.

At T68 s3 should have switched from the 4-stop Ham+Oil chain to the 6-stop Ham + Sevilla→London + Oil chain. The London connector would have been built during T68-T75 instead of T78-T80, and s3 would have likely won several turns earlier than s2.

## Acceptance

- **AC1** — Unit test on the idempotency check at `AIStrategyEngine.ts:294-298`: fixture where the existing `activeRoute` is `[pickup Ham@Warszawa, deliver Ham@Glasgow, pickup Oil@Beograd, deliver Oil@Hamburg]` (currentStopIndex=0) and `findFinalVictoryRoute` returns `[pickup Ham@Warszawa, deliver Ham@Glasgow, pickup Oranges@Sevilla, deliver Oranges@London, pickup Oil@Beograd, deliver Oil@Hamburg]`. Assert the post-fix idempotency check **does NOT** suppress the override (the longer route replaces the shorter one).
- **AC2** — Negative test: existing activeRoute is `[pickup Ham@Warszawa, deliver Ham@Glasgow]` and `findFinalVictoryRoute` returns the same `[pickup Ham@Warszawa, deliver Ham@Glasgow]`. Assert idempotency check SUPPRESSES (no churn when the proposed plan is identical).
- **AC3** — Edge: existing activeRoute has currentStopIndex advanced (e.g., 2 of 4 stops completed). `findFinalVictoryRoute` returns a fresh route starting with the existing route's remaining first stop. Decide policy: suppress (mid-route, the current trajectory is committed) OR replace (let the victory route win since the rest diverges). Document the chosen policy in the test.
- **AC4** — Integration: replay s3 T67 through T80 against game `8350cffa-d357-45b4-9bbb-eafeefd60a55`. Assert: by T75 the bot has either connected to London OR is en route to a London-pickup-or-delivery leg. The bot must NOT spend T68-T74 on the Beograd→Hamburg round-trip without having committed to the Sevilla-or-London leg first.
- **AC5** — Negative case (over-trigger guard): a snapshot where the proposed and existing routes diverge ONLY in stops the existing route has already completed (currentStopIndex advanced past them). Assert idempotency check still SUPPRESSES (the divergence is irrelevant — it's in the past).

## Not in scope

- LLM-side route planning. The bot in this game used the deterministic Medium-skill path throughout. LLM contributions to the route planning at T67 were diagnostic-only.
- The user's surface framing "could have won at T74 by connecting 2 mp to London". The math doesn't support that specific claim (T74 cash $223M < $250M threshold AND 3 majors connected, needs 4 more, not 1). The underlying complaint — the bot took the wrong route at T67 — is the real defect.
- Victory-clinch fast-path (`detectVictoryClinch`, JIRA-243). That gate fires only when the bot can win in a SINGLE delivery from the current state. T67 was not a clinch state.
- The `connectedMajorCities` count itself — verified to be correctly computed in this game (matches the victoryCheck rollup at T80/T83).

## Relationship to existing JIRAs

- **JIRA-245 / findFinalVictoryRoute**: the function works correctly — diagnostic reproduction confirms it fires and returns viable routes. The fix is in JIRA-245's CALLER (AIStrategyEngine's idempotency check), not in JIRA-245 itself.
- **JIRA-241 / applyEndStateScoring**: orthogonal — runs only inside DeterministicTripPlanner when findFinalVictoryRoute returns null. Not implicated by the current diagnosis.
- **JIRA-243 / detectVictoryClinch**: orthogonal — only handles single-delivery wins. Not applicable at T67.

## User-facing impact

For a single game: s3 was the leading bot at T65 ($202M, 3 majors). By T75 s3 had crossed $250M ($260M) but was still at 3 majors. The 8-turn lock-in spent income on a round-trip when the bot should have been building connectors. s2 won at T83 — a ~16-turn opportunity cost from s3's perspective. Across all bot-vs-bot games, end-game route lock-in likely accounts for a non-trivial share of "leading bot fails to convert lead into victory" outcomes. Quantifying is out of scope here; the priority is fixing the specific replan-at-end-state-entry case the trace reveals.

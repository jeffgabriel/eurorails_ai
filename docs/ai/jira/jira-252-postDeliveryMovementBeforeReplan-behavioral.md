# JIRA-252 — Post-delivery turn spends remaining movement budget against the stale route before the replan runs (behavioral)

In game `3da56057-cf04-49c0-a194-b43fd0010bd4`, player Sonnet delivers Fish at Krakow somewhere between T40 and T42 (the actual delivery turn — T41 in the suspected window — is missing from the per-turn log; T40 shows the bot mid-route with cash=7M, T42 shows cash=83M and a fully-rotated demand hand with `Fish→Krakow` gone). The active route at T42 still reads `[pickup(Fish@Aberdeen), deliver(Fish@Krakow)]` — i.e. the post-delivery replan has NOT yet replaced it.

The user-observed symptom (paraphrased from real-game observation, approximate turn numbers): the bot delivers Fish at Krakow, draws a new demand card, then heads **west** using its remaining movement budget — with no fresh plan yet. After the budget is spent, the planner finally runs and produces a new route that takes the bot back **east** to Lodz. The next turn (T43) the bot upgrades to Superfreight and ends at Lodz (positionEnd=Lodz), consistent with the new `pickup(Potatoes@Lodz)` route. The intervening turn's westward movement is wasted — the bot covers ground in the opposite direction of the new plan and then has to reverse.

Expected behavior: when a delivery completes mid-turn and a new demand card is drawn, the executor should **stop the train at the delivery city**, run a fresh `TripPlanner` replan against the updated demand hand, and ONLY THEN spend any remaining movement budget — so the remaining movement applies to the new route, not the old one.

## Source

`logs/game-3da56057-cf04-49c0-a194-b43fd0010bd4.ndjson`, player Sonnet. Affected turn range T40–T43.

## Observed trace (Sonnet T39–T43)

| Turn | Action | positionStart | positionEnd | Active route stops | Cash | Demand-card hand changed? | moveBudget used |
|------|--------|---------------|-------------|---------------------|------|----------------------------|------------------|
| T39  | MoveTrain | — | — | `[pickup(Fish@Aberdeen), deliver(Fish@Krakow)]` | 7M | no | 12/12 |
| T40  | MoveTrain | — | — | `[pickup(Fish@Aberdeen), deliver(Fish@Krakow)]` | 7M | no | 12/12 |
| T41  | **(turn entry missing from per-turn log)** — Fish→Krakow delivery presumed here based on cash + demand-hand transition between T40 and T42 |  |  |  |  |  |  |
| T42  | MoveTrain | — | — | `[pickup(Fish@Aberdeen), deliver(Fish@Krakow)]` (stale) | 83M | **yes — `Fish→Krakow` gone; hand now has `Potatoes→Holland`, `Wood→Paris`, etc.** | 0/12 |
| T43  | UpgradeTrain | — | Lodz | `[pickup(Potatoes@Lodz), pickup(Wood@Sarajevo), deliver(Potatoes@Holland), deliver(Wood@Paris)]` (fresh, marked `[route-planned]` in reasoning) | 63M (83 − 20 upgrade) | no | 12/12 |

The two key signals:
- **T42's `moveBudget.used = 0`** despite `action = MoveTrain` — the executor went through the motion of "MoveTrain" but emitted no segments, consistent with the stale route's next stop being a delivery the bot already completed (Krakow), so there was nothing left to move toward on the old plan.
- **T42's `activeRoute` is still the Fish route** even though the demand-hand has rotated — confirming the replan didn't run mid-turn at the delivery moment.

The user-described "headed west with no plan" portion is what would have happened if movement budget had been > 0 at T42 with the stale route still partially executable; in this particular game the budget happened to be 0, so no wrong-direction motion is observable in this trace. But the user has observed the bot-heads-wrong-direction symptom in earlier sessions of the same game (and likely others) — the **ordering bug** is real even when this specific log only captures the "movement budget was 0" failure mode.

## Expected behavior

When the executor processes a `deliver` stop and the delivery succeeds:

1. **Complete the delivery.** Update `bot.loads`, return load chip, draw new demand card.
2. **Mark the active route's stop as complete.** If the delivery was the last stop, the route becomes "completed" — clear `activeRoute`.
3. **Stop the train at the delivery city** for the remainder of the turn. Do NOT continue spending movement budget against the stale route.
4. **Run a fresh `TripPlanner` replan** against the updated demand hand. The new route's first stop is the new "next" for the bot.
5. **Apply the remaining movement budget to the new route.** If the new route's first stop is on-network, move toward it. If it requires building, the build phase (Phase B) handles it next turn — no movement budget spent.

What must NOT happen:
- The executor continues issuing `MoveTrain` segments against the stale route after delivery.
- The replan runs at end-of-turn (after the move) instead of immediately after the delivery.
- The bot uses remaining movement budget to head in a direction that the next-turn replan reverses.

## Acceptance

- **AC1** — Construct a fixture matching T40-T42: bot mid-route, route has one remaining `deliver(X@CityA)` stop, bot has ≥6 mileposts of remaining movement after the delivery would complete. Assert: after the deliver step executes, the executor invokes `TripPlanner.planTrip` with the updated demand hand BEFORE any further `MoveTrain` segments are emitted.
- **AC2** — Same fixture. Assert: any movement emitted AFTER the deliver step belongs to the NEW route's first move-toward-stop step, not the stale route.
- **AC3** — Same fixture, but the deliver completes the route entirely (no remaining stops on the old route). Assert: `activeRoute` is cleared, the new route from `TripPlanner.planTrip` becomes the active route, and remaining movement budget is applied to the new route's first stop (if on-network).
- **AC4** — Same fixture, but the new route's first stop is OFF-network (requires building). Assert: no movement segments emitted post-delivery; the build phase runs next turn instead.
- **AC5** — Full-game regression against the T40-T43 segment of game `3da56057`. Assert: at T42 (or equivalent post-delivery turn), `activeRoute` reflects the FRESH plan, not the stale Fish route. The "intervening turn with stale route still active" should disappear.
- **AC6** — Per-turn log must show the replan invocation in the same turn as the delivery (e.g. a `[route-replanned-post-delivery]` reasoning entry, or `composition.replanCount > 0`), so future log forensics can verify the ordering.

## Not in scope

- The general case of "stale route detected later, replan triggers a route abandonment" (handled by existing route-stale guardrails — JIRA-89, JIRA-129, etc.). This ticket is specifically about the mid-turn ordering at the delivery point.
- LLM-side post-delivery prompts (the `Hard` skill path may have its own replan flow). Focus this fix on the deterministic (`Medium` skill) path that produced the observed symptom.
- The T41 missing-log entry — separate concern about turn-logging completeness; only relevant here as a forensic gap, not a fix target.

## Relationship to existing JIRAs

- **JIRA-129** added post-delivery TripPlanner replan logic with `activeRoute` update in memory after the replan. That fix established THAT a replan should happen; this ticket is about the ORDERING — that the replan must occur BEFORE remaining movement, not after the whole turn settles.
- **JIRA-156** added mid-turn replan support (RouteEnrichmentAdvisor stub). Related infrastructure; verify the post-delivery hook hits this path correctly.
- **JIRA-248** (just shipped on `fix/jira-248-249-250-carried-load-planner`) ensures the replan correctly accounts for carried loads. With JIRA-248 in place, the post-delivery replan now produces correct candidate sets — but it still needs to RUN at the right moment, which is what JIRA-252 addresses.

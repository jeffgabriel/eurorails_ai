# JIRA-276 — Bot emits a discretionary train upgrade that consumes the cash needed to complete its just-committed route, stranding it broke-and-stuck (behavioral)

In game `c094a3ef-2a08-4017-ab9f-916e1e20e988`, player Sonnet at T14 delivers China @ Firenze (+22M, bringing cash to ~23M), commits to a fresh deterministic route `pickup(Tobacco@Napoli) → deliver(Tobacco@Zurich)` (planner-rated NET 19M, build 3M, 3 turns), and then emits a `fast_freight` upgrade costing 20M. The upgrade's affordability check considered only the current turn's outlay (20M upgrade + 3M build = 23M, exactly the post-delivery cash) and left the bot with 3M. 3M is not enough to build the track required to reach the Napoli pickup and Zurich delivery the bot just committed to, so at T15 the bot is broke (cash 3M), has no executable route, and the **Unaffordable-Stuck guardrail forces a `DiscardHand`** — throwing away the committed Tobacco→Zurich route entirely.

The upgrade is a *discretionary* end-of-turn action (Phase B alternative to building). Spending 20M on it directly caused the bot to abandon a route it had just selected as its best play.

## Source

`logs/game-c094a3ef-2a08-4017-ab9f-916e1e20e988.ndjson`, player Sonnet, T10–T15.

## Observed trace

| Turn | action | cost | cash (logged) | note |
|------|--------|-----:|-----:|------|
| T10 | BuildTrack (3 seg) | 5 | 12 | |
| T11 | BuildTrack (9 seg) | 11 | 1 | built down to 1M |
| T12 | MoveTrain | 0 | 1 | |
| T13 | MoveTrain | 0 | 1 | |
| T14 | **UpgradeTrain → fast_freight** | 20 | 3 | delivered China @ Firenze (+22M → ~23M) earlier in the same turn, then upgraded |
| T15 | DiscardHand (forced) | 0 | 3 | `decisionSource: guardrail-enforcer`, `actor: guardrail` |

T14 decision detail:
- `decisionSource: route-executor`; `activeRoute.stops = [pickup Tobacco@Napoli, deliver Tobacco@Zurich]`.
- `actionTimeline`: `move → deliver(China@Firenze, +22M) → move → upgrade(fast_freight)`.
- Planner reasoning (verbatim): **`Upgrade emitted: fast_freight (cost 20M, cash 23M, build 3M).`** — the check is `cash 23M ≥ 20M upgrade + 3M build`; it does not subtract the *remaining* build cost to reach Napoli/Zurich.

T15 consequence:
- `action: DiscardHand`, forced by the **Unaffordable-Stuck** guardrail (`GuardrailEnforcer.ts:161`): no active route, no deliverable load, and no affordable+connectable demand.
- Composition trace at T15 shows the route was unrealizable on 3M: `a2.terminationReason: "stop_city_not_on_network"`.

## The user's hypothesis (verbatim)

> upgrade without checking if it has enough cash on hand to complete the planned route

## Expected behavior

The discretionary upgrade should not be emitted when paying for it would leave the bot unable to fund the remaining build cost of the route it just committed to. In this trace, the bot had just selected `Tobacco@Napoli → Zurich` as its best route; with the required build to reach those stops, spending 20M on a non-essential upgrade strands that commitment. The bot should defer the upgrade (build toward / continue the committed route instead) and upgrade on a later turn once the route is funded or further along.

This is **not** a request to hold a cash reserve floor. The bot may still spend to zero building track and executing deliveries on its committed route. The defect is spending on a *discretionary* upgrade that makes an *already-committed* route uncompletable.

## Acceptance

- Regression scenario reconstructed from this trace: a bot at ~23M immediately after an in-turn delivery, with a freshly committed multi-turn route whose remaining build cost exceeds `cash − upgradeCost`, does **not** emit the upgrade that turn.
- In that scenario the committed route progresses toward a delivery on subsequent turns rather than being discarded by the Unaffordable-Stuck guardrail on the next turn.
- The upgrade-emit decision's affordability accounting includes the committed route's remaining build cost, not only the current turn's upgrade + build outlay.

## Not in scope

- Changing upgrade economics or the 20M upgrade cost.
- Any cash-reserve / minimum-balance rule (explicitly rejected — bots may spend to zero on their route).
- The Unaffordable-Stuck guardrail itself, which behaved correctly at T15 (it is the symptom-catcher, not the cause).
- Generalizing to other discretionary spends or other games beyond this single observation.

## Relationship to existing JIRAs

- **JIRA-277 (Fresh Turn Snapshot Contract) — explicitly NOT this bug.** That refactor guards against applying a plan derived from *stale* snapshot facts. Here the T14 snapshot was *fresh and correct*: the planner used `cash 23M`, which already reflected the in-turn China delivery (mid-turn cash sync working). `assertFresh`/identity comparison would pass. This defect is a forward route-affordability lookahead gap in the deterministic planner's upgrade-emit logic, not a staleness/freshness mismatch. It is a distinct check (forward cash lookahead vs. fact freshness) on a distinct code path.

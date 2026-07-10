# JIRA-257 — Guardrail G1 "Force DELIVER" bypasses the pickup/delivery restriction predicate, causing 3-turn loops when an active Strike blocks the bot's only deliverable city (behavioral)

In game `182bfd36-3d3d-46ef-9c1d-0c87373b983f` (Phase 4 — JIRA-256 in effect), a Coastal Strike event was active starting around turn 31. Players Haiku and s1 were each carrying a load with a matching demand at a coastal city covered by the Strike (Haiku: Marble at London; s1: Cars at Antwerpen). The bots' LLM/route-executor correctly chose `PassTurn` (Haiku) or `BuildTrack` (s1) as the turn action. The GuardrailEnforcer overrode that choice with a Forced DELIVER. PlayerService then rejected the delivery with `ActionRestrictionError(COASTAL_STRIKE_BLOCKED)`. The same override-and-reject sequence repeated for 3 consecutive turns per player before the Strike expired.

## Source

`logs/game-182bfd36-3d3d-46ef-9c1d-0c87373b983f.ndjson`, players Haiku (turns 31, 32, 33) and s1 (turns 31, 32).

## Observed trace — Haiku at London with Marble (card 43, payout 31M)

| Turn | LLM/executor chose | guardrailOverride | guardrailReason | TurnExecutor outcome | rejectionReason.code | cash after |
|------|---------------------|-------------------|------------------|-----------------------|----------------------|------------|
| 31 | PassTurn (`[stuck-route-abandon] no progress for 16 turns`) | true | "Forced DELIVER: Marble at London for 31M (LLM chose PassTurn)" | success=false; error="Delivery blocked by active event (Strike): city London is within the coastal strike zone" | COASTAL_STRIKE_BLOCKED | 31 (unchanged) |
| 32 | PassTurn (`[route-planned] Deliver Marble at London…`) | true | (same) | success=false; (same error) | COASTAL_STRIKE_BLOCKED | 31 (unchanged) |
| 33 | PassTurn (`[route-executor] stop 0/1, phase=build`) | true | (same) | success=false; (same error) | COASTAL_STRIKE_BLOCKED | 31 (unchanged) |

## Observed trace — s1 at Antwerpen with Cars (card 110, payout 12M)

| Turn | LLM/executor chose | guardrailOverride | guardrailReason | TurnExecutor outcome | rejectionReason.code |
|------|---------------------|-------------------|------------------|-----------------------|----------------------|
| 31 | PassTurn (`[stuck-route-abandon] no progress for 11 turns`) | true | "Forced DELIVER: Cars at Antwerpen for 12M (LLM chose PassTurn)" | success=false; error="Delivery blocked by active event (Strike): city Antwerpen is within the coastal strike zone" | COASTAL_STRIKE_BLOCKED |
| 32 | BuildTrack (`[route-planned] [deterministic-top-1] pair:110-Cars+102-Copper…`) | true | "Forced DELIVER: Cars at Antwerpen for 12M (LLM chose BuildTrack)" | success=false; (same error) | COASTAL_STRIKE_BLOCKED |

## Expected behavior

When the GuardrailEnforcer is considering forcing a DELIVER override (i.e., the bot's hand has a deliverable load at its current city and the LLM chose something else), it should first check the active pickup/delivery restrictions and skip the override if the candidate delivery is blocked. The override exists to correct LLM strategy mistakes ("you should be delivering, not building"); it must not force an action that the game-rule layer will then reject as illegal.

In the specific cases above:
- Haiku turns 31–33: the LLM's `PassTurn` was the correct response to "I can't legally deliver Marble at London while the coastal Strike is active." The guardrail should have respected that and not overridden.
- s1 turn 32: the LLM's `BuildTrack` toward Beograd was a legitimate non-delivery action during the Strike. The guardrail should have respected that and not overridden.

## User-facing impact

Per player, per active Strike that covers a city where the bot has a deliverable load: 2–3 wasted turns of `guardrailOverride: true` → `success: false` → no progress. Two players were hit simultaneously in this game; the Strike likely affected several other cities and players too, but those evidence rows weren't surveyed. Compounds with multiple Strike-vulnerable carried loads could lose 4–6 turns.

There's also a downstream log-fidelity bug — the rejected DeliverLoad still appears in `loadsDelivered` and `actionTimeline` in the turn entry, falsely implying a successful delivery. That's tracked separately in JIRA-258 (different code locus).

## Acceptance

- **AC1** — Replicate Haiku T31 snapshot: bot at London carrying Marble, demand card `Marble→London` in hand, active effect `CoastalStrike` listing London in its restricted city set. Invoke `AIStrategyEngine.takeTurn` (or directly `GuardrailEnforcer.checkPlan` with a `PassTurn` plan and a `canDeliver` context containing Marble@London). Assert: the returned plan is NOT a forced DELIVER — it is the original PassTurn passed through.
- **AC2** — Same fixture but no Strike active. Assert: G1 still fires and forces DELIVER (regression guard — the predicate-aware path must only suppress the override when the delivery is actually blocked).
- **AC3** — Hand has TWO carried-deliverable loads, only one of which is at a Strike-blocked city. Bot is positioned at the blocked city; the other deliverable's city is on the bot's route but not currently reached. Assert: G1 does not force DELIVER for the blocked city. (Whether it forces DELIVER for the other city depends on `context.canDeliver` semantics — if the other isn't a `canDeliver`, then `PassTurn` should pass through.)
- **AC4** — Integration: replay Haiku T31 of game `182bfd36-3d3d-46ef-9c1d-0c87373b983f`. Assert: the bot's turn action is `PassTurn` (not Forced DELIVER), `guardrailOverride` is `false` or `undefined`, and `rejectionReason` does NOT appear in the turn entry.

## Not in scope

- Any change to the `isPickupDeliveryBlocked` predicate itself — the predicate is correct (it correctly rejected the deliveries inside PlayerService); the bug is that the guardrail doesn't consult it before forcing.
- Forced-DELIVER suppression for other restriction families (movement, build, lost-turn). Only the pickup/delivery family is in scope here.
- The "loadsDelivered populated despite failed delivery" log-fidelity bug — see JIRA-258.
- The "TripPlanner picks routes through Strike-blocked cities" candidate-enumeration bug — see JIRA-259.

## Relationship to existing JIRAs

- **JIRA-256** (Phase 4 — Bot Event-Card Awareness): this defect is a regression in BE-006's GuardrailEnforcer integration. BE-006 added the `PICKUP_DELIVERY_RESTRICTION_VIOLATION` gate inside `checkPlan`, but that gate runs AFTER the G1 Force DELIVER short-circuit, so it never gets a chance to suppress the override.
- **JIRA-251** (bot blind to active rail strike): adjacent failure mode that JIRA-256 was meant to fix. The G1 bypass is the residual hole.

# JIRA-124: JIT Gate trackRunway Miscalculation — Measures Wrong Stop

_Analysis of game `eb69a74e`. Despite JIRA-122 JIT track building being implemented, Flash bot still over-commits to premature builds because the trackRunway calculation targets the wrong stop._

## The Bug

The JIT gate's `trackRunway` field measures distance to the nearest unconnected city on the route — not the **current stop** the train is actively heading toward. This causes the gate to trigger builds toward later stops while the train is still servicing earlier ones, defeating the purpose of just-in-time building.

## The Evidence: Game `eb69a74e`, Flash Bot

### Timeline

| Turn | Action | Train Position | Build Target | Cost | Cash After | Notes |
|------|--------|---------------|-------------|------|------------|-------|
| T21 | UpgradeTrain | (28,45) | — | 20M | ~22M | Route: Coal(Wroclaw→Frankfurt) → Tobacco(Napoli→Warszawa) |
| T22 | BuildTrack | (28,45)→(22,51) | Napoli | 14M (10 segs) | 2M | JIT gate: `trackRunway: 1.25`, `reason: "build_needed"` |
| T23 | BuildTrack | (22,51)→(27,58) | Napoli | 2M (2 segs) | 0M | **Bot is now broke** |
| T24-28 | MoveTrain | Moving toward Frankfurt/Napoli | — | — | — | Train still in transit |
| T26 | — | — | — | — | — | Route re-evaluated: adds Marble pickup at Firenze |
| T29 | MoveTrain | Arrives Napoli | — | — | — | Tobacco pickup — **7 turns after build** |

### What Went Wrong

1. **JIT gate measured the wrong stop.** At T22, the train was heading to Frankfurt (stop 0 — Coal delivery). Napoli (stop 1 — Tobacco pickup) was 7+ turns of movement away. But the JIT gate reported `trackRunway: 1.25 turns` and `destinationCity: "Frankfurt"` — it detected the train needed track soon for Frankfurt but the build targeted Napoli instead.

2. **Premature build drained all cash.** 16M spent across T22-T23 on Napoli track left the bot at 0M. This is catastrophic — the bot couldn't build, pay track use fees, or respond to opportunities for multiple turns.

3. **Route changed 4 turns after the build commitment.** At T26, the route was re-evaluated to add a Firenze/Marble pickup opportunity. If the bot had deferred the Napoli build, it would have had 16M available to invest more strategically.

## Root Cause Analysis

The JIT gate (implemented in JIRA-122) has a disconnect between two calculations:

- **`trackRunway`**: Measures how many turns of movement before the train runs out of existing track — correctly identifies when the train needs more track for the **current direction of travel**
- **Build target selection**: Picks the build target from the route's next unconnected stop — which may be a **different stop** than the one the train is actively heading toward

When these diverge (train heading to stop N, build targeting stop N+1), the gate triggers a premature build. The 1.25-turn runway was real — for Frankfurt. But the build went toward Napoli, which wasn't needed for 7+ turns.

## Expected Behavior

The JIT gate should:
1. Identify which stop the train is **currently heading toward** (stop 0 in the route's execution order)
2. Only build track toward **that stop** — not future stops
3. Defer builds toward later stops until the train is within 1-2 turns of needing track in that direction
4. Never build toward stop N+1 while still executing stop N, unless stop N is complete and the train is transitioning

## Affected Files

- `src/server/services/ai/TurnComposer.ts` — JIT gate `trackRunway` calculation and build target selection
- `src/server/services/ai/PlanExecutor.ts` — Route stop execution order (provides `currentStopIndex`)
- `src/server/services/ai/ActionResolver.ts` — `resolveBuild()` target selection

## Acceptance Criteria

- [ ] JIT gate only triggers builds toward the stop the train is currently executing (matching `route.currentStopIndex`)
- [ ] Builds toward future stops (index > currentStopIndex) are deferred until the train transitions to that stop
- [ ] Bot does not go broke from premature builds toward later route stops
- [ ] Route re-evaluations that happen between build and arrival can benefit from preserved cash
- [ ] All JIT gate decisions log the current stop index and build target stop index for observability

## Priority

HIGH — In game `eb69a74e`, Flash went broke (0M) building toward a stop 7 turns away, missing a route optimization opportunity that emerged 4 turns later. The JIRA-122 JIT gate is firing but targeting the wrong stop.

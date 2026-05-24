# JIRA-154: JIT Gate Ignores Intermediate Travel Time — Premature Builds Persist

_Analysis of game `3b089922`. Despite JIRA-122 (JIT gate) and JIRA-124 (runway miscalculation fix), both bots still build track 4-8 turns too early because the gate skips on-network stops without accounting for the travel time to complete them._

## Two Bugs

### Bug 1: JIT gate build target skips on-network stops without counting travel time

The build target selection loop (TurnComposer.ts lines 850-859) iterates route stops and picks the **first city NOT on the network**:

```typescript
for (const stop of activeRoute.stops) {
  if (!isStartingCity && !context.citiesOnNetwork.includes(stop.city)) {
    buildTarget = stop.city;
    break;
  }
}
```

This correctly skips stops the bot already has track to — but it ignores the **turns of travel needed to execute those stops**. When stops 0-2 are on-network but require 4-8 turns of movement/pickup/delivery, the gate jumps straight to stop 3's build target and finds low runway → allows building immediately.

### Bug 2: Build advisor prompt is too open-ended

The build advisor system prompt says "recommend the best track building strategy" and gives the LLM actions like `buildAlternative`, `replan`, `useOpponentTrack`. The LLM interprets this as a strategic planning role, generating responses like:

> "Build a low-cost corridor from the existing Wien network toward the Milano area while avoiding Alpine-heavy cells; only use opponent track if required to stay within the 20M ECU cap"

The build advisor should be a constrained pathfinding directive ("connect your network to city X"), not a strategy advisor. The LLM hallucinates about "future pushes toward Zagreb/Sarajevo" and ignores the `T` (build target) marker on the corridor map.

## Evidence: Game `3b089922`

### Haiku (player 64dad655) — Builds toward Holland at T4

| Turn | Phase | Cash | Route | Current Stop | Build Action |
|------|-------|------|-------|-------------|-------------|
| T3 | Initial Build | 27M | Warszawa(pickup) → Budapest(deliver) → Budapest(pickup) → Holland(deliver) | 0 (Warszawa pickup) | Initial build |
| T4 | Early Game | 7M | Same | 0 (Warszawa pickup) | **Builds toward Holland** |

**What went wrong:**
- Route stops: Warszawa → Budapest → Budapest → Holland
- `citiesOnNetwork`: includes Warszawa and Budapest (built during initial build)
- Build target loop skips stops 0-2 (on network), lands on **Holland** (stop 3)
- `calculateTrackRunway` to Holland returns < 2 → gate allows build
- Bot still needs to: travel to Warszawa (~1 turn), travel to Budapest and deliver (~2 turns), pickup Bauxite, THEN head toward Holland
- **Effective need for Holland track: ~4+ turns away**
- Build advisor spends 20M building toward Holland, leaving bot at 7M

### Nano (player 6754a16f) — Builds toward Milano at T4

| Turn | Phase | Cash | Route | Current Stop | Build Action |
|------|-------|------|-------|-------------|-------------|
| T3 | Initial Build | 22M | Beograd(pickup Oil) → Wroclaw(deliver) → Bern(pickup Cheese) → Milano(deliver) | 0 (Beograd pickup) | Initial build |
| T4 | Early Game | 3M | Same | 0 (Beograd pickup) | **Builds toward Milano** |

**What went wrong:**
- `CITIES ON NETWORK: Wien, Beograd, Wroclaw` — stops 0-1 are connected
- Build target loop skips Beograd and Wroclaw, lands on **Bern or Milano**
- Bot still needs to: pick up Oil at Beograd (~1 turn), travel to Wroclaw and deliver (~3-4 turns), travel to Bern (~4+ turns), THEN head toward Milano
- **Effective need for Milano track: ~8+ turns away**
- Build advisor LLM ignores the actual build target and generates a "corridor strategy" toward Milano
- Spends 19M, leaving bot at 3M — nearly broke entering the travel phase

## Root Cause

JIRA-124 fixed the mismatch between runway measurement and build target (measuring runway to stop N but building toward stop N+1). But the deeper issue remains: **the gate treats on-network stops as free**. When stops 0-2 are on the network, the gate behaves as if the bot can teleport through them and immediately needs track for stop 3.

The correct mental model: even if stops 0-2 are on the network, the bot needs N turns to traverse, load, and unload at each. The effective runway to the build target should include that travel time.

## Proposed Fix

### Fix 1: Account for intermediate stop travel time in JIT gate

Instead of just checking `calculateTrackRunway(buildTarget)`, the gate should estimate turns to complete all preceding on-network stops:

```
effectiveRunway = turnsToCompleteIntermediateStops + trackRunwayToBuildTarget
```

Where `turnsToCompleteIntermediateStops` estimates the travel time from the bot's current position through all on-network stops before the build target. A rough heuristic:
- For each skipped stop between currentStopIndex and the build target stop: estimate travel turns based on distance / trainSpeed
- If effectiveRunway >= 2, defer the build

### Fix 2: Constrain build advisor prompt

The build advisor prompt should be a focused directive:
- Remove strategic language ("recommend the best track building strategy")
- Remove open-ended actions (`buildAlternative`, `replan`, `useOpponentTrack` as strategy options)
- Replace with: "Build track to connect your network to [TARGET CITY]. Provide waypoints for the cheapest path."
- The LLM's only job is pathfinding, not strategy

## Affected Files

- `src/server/services/ai/TurnComposer.ts` — JIT gate build target selection (lines 850-859) and `shouldDeferBuild()` (lines 1321-1372)
- `src/server/services/ai/BuildAdvisor.ts` — System prompt and action set

## Relationship to Prior JIRAs

- **JIRA-122**: Introduced JIT gate — this bug is a gap in the original design
- **JIRA-124**: Fixed runway/target mismatch — this bug is the next layer: target selection itself is premature
- **JIRA-148**: Added `shouldDeferBuild` gate — the gate logic needs the intermediate travel time factor

## Acceptance Criteria

- [ ] JIT gate estimates travel time through all on-network intermediate stops before allowing builds toward later stops
- [ ] Bot does not build toward stop N when it still has 3+ turns of travel/delivery work on stops 0 through N-1
- [ ] Build advisor prompt is constrained to "connect network to city X" — no strategic planning
- [ ] Build advisor LLM response must target the city passed by the JIT gate, not a self-selected destination
- [ ] Game 3b089922 replay: neither bot builds toward final destination at T4

## Priority

HIGH — Both bots in game 3b089922 spend nearly all their cash on premature builds at T4, entering the travel phase nearly broke. This directly causes poor early-game performance and compounds across the entire game.

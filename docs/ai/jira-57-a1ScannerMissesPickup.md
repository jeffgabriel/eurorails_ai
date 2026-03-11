# JIRA-57: A1 Scanner Misses Pickup When Bot Passes Through Supply City

## Bug Description

The A1 opportunistic scanner in `splitMoveForOpportunities()` fails to detect pickup opportunities when the bot passes through a supply city during its MOVE. This causes the bot to waste an entire turn returning to pick up a load it already passed through.

## Evidence

Game `ff240679`, Flash (gemini-3-flash-preview):

- **Turn 4**: Flash moves toward Bruxelles. `a1.citiesScanned=2, opportunitiesFound=0`. Moves only 3/9 mileposts, wastes 6. Builds 10M track toward Manchester. Chocolate is available at Bruxelles and Flash has a demand for Chocolate→Manchester.
- **Turn 5**: Flash picks up Chocolate at Bruxelles as a separate action. `moveBudget.used=4, wasted=5`. The A2 continuation adds a MOVE but doesn't use full budget.

**Net impact**: The pickup+delivery that should have taken 2 movement turns took 4 turns (T4 approach, T5 pickup, T6 move, T7 deliver). ~11 wasted mileposts across T4-T5.

## Root Cause

The A1 scanner scans cities along the MOVE path for pickup/deliver opportunities. On Turn 4, it scanned 2 cities but found 0 opportunities. Possible causes:

1. The MOVE path didn't actually pass through Bruxelles on T4 (stopped short)
2. The A1 scanner's feasibility check rejected the Chocolate pickup for some reason (BE-001 capacity check?)
3. The MOVE was only 3 mileposts — maybe the bot hadn't reached Bruxelles yet and the remaining 6 mileposts were wasted due to a path issue

Need to investigate whether the bot's track reached Bruxelles by T4 and whether the MOVE path included it.

## Affected Files

- `src/server/services/ai/TurnComposer.ts` — `splitMoveForOpportunities()` A1 scanner logic
- Possibly route executor / PlanExecutor — may be generating a short MOVE that stops before Bruxelles

## Additional Note

There's also a tracking discrepancy on T5: `moveBudget.used=4` but `milepostsMoved=6`. These should agree.

# JIRA-68: Guardrail Stuck Detection Forces DiscardHand During Active Route Travel

## Bug Description

The GuardrailEnforcer's stuck detection forces `DiscardHand` while the bot is actively traveling toward a pickup city on a valid route. This is catastrophic: the bot **discards the very demand cards it was traveling to fulfill**, destroying the payout it spent multiple turns working toward. It also loses a turn, then resumes moving toward the same city — now without matching demand cards, making the entire journey wasted.

## Evidence

### Game `be09cd45`, Flash (gemini-3-flash), T24:
- Flash was mid-route: Ham Warszawa→Roma (stop 0/2, moving toward Warszawa for pickup)
- T21-T23: `MoveTrain` each turn, 9/9 mileposts used, making steady progress toward Warszawa
- T24: PlanExecutor returned `MoveTrain` (inputPlan: `["MoveTrain"]`), 9/9 mileposts used — **but guardrail overrode to `DiscardHand`**
- T25: Immediately resumes `MoveTrain` toward Warszawa with new (worse) demand cards
- Cash: 39M (not broke), handQuality: 5.37 ("Good")

### Log excerpt (T24):
```
guardrailOverride: true
guardrailReason: "Progress-based stuck detection: 3 turns with no deliveries, cash increase, or new cities — forcing DiscardHand"
composition.inputPlan: ["MoveTrain"]
composition.moveBudget: { total: 9, used: 9, wasted: 0 }
```

## Root Cause

**Stuck detection doesn't recognize empty-handed travel toward a pickup as progress.**

The progress tracker (`AIStrategyEngine.ts:360-368`) defines progress as:
```typescript
const isActivelyTraveling = snapshot.bot.loads.length > 0 && activeRoute != null;
const madeProgress = hadDelivery || hadCashIncrease || hadNewTrack || isActivelyTraveling || hadDiscard;
```

The JIRA-45 fix added `isActivelyTraveling` but requires `loads.length > 0` — only exempting bots **carrying loads**. A bot traveling empty toward its pickup city (a normal and necessary part of any route) is not recognized as making progress.

T21-T23 each had: no deliveries, no cash increase, no new track (city already on network), no loads carried. After 3 turns, `noProgressTurns` reached 3 and the guardrail at `GuardrailEnforcer.ts:64` fired:

```typescript
if (noProgressTurns >= 3 && planType !== AIActionType.DiscardHand && snapshot.bot.loads.length === 0) {
```

This check also has no awareness of the active route — it only checks `loads.length`.

## Fix

### Part 1: Progress tracker (AIStrategyEngine.ts:366)

Count traveling on an active route as progress regardless of load state:

```typescript
// Before (JIRA-45):
const isActivelyTraveling = snapshot.bot.loads.length > 0 && activeRoute != null;

// After:
const isActivelyTraveling = activeRoute != null;
```

### Part 2: Guardrail stuck detection (GuardrailEnforcer.ts:64)

Pass `hasActiveRoute` to `checkPlan()` and skip stuck detection when the bot has an active route:

```typescript
// GuardrailEnforcer.checkPlan() — add hasActiveRoute param
if (noProgressTurns >= 3 && planType !== AIActionType.DiscardHand
    && snapshot.bot.loads.length === 0 && !hasActiveRoute) {
```

Both fixes are needed: Part 1 prevents `noProgressTurns` from accumulating during route travel; Part 2 is defense-in-depth so the guardrail never fires DiscardHand over an active route even if progress tracking has a gap.

## Affected Files

- `src/server/services/ai/AIStrategyEngine.ts:366` — change `isActivelyTraveling` to not require loads
- `src/server/services/ai/GuardrailEnforcer.ts:36,64` — add `hasActiveRoute` param, guard stuck detection
- `src/server/__tests__/ai/GuardrailEnforcer.test.ts` — test that stuck detection skips when active route exists

## Impact

Devastating — the bot loses the demand cards it was actively pursuing, destroying turns of invested travel. In game be09cd45, Flash spent T20-T23 (4 turns) traveling toward Warszawa for a Ham→Roma route (29M+ payout), then the guardrail discarded those cards at T24. The bot drew new cards and resumed moving toward Warszawa anyway (T25-T26), but now without the Ham demand — the entire journey was wasted. Any multi-turn route to a distant pickup city is vulnerable: the bot will always accumulate 3+ "no progress" turns when traveling 3+ turns empty, triggering this bug.

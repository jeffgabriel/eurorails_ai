# JIRA-123: Route Planner Allows Two Deliveries From Same Demand Card

## Evidence

**Game:** `eb69a74e` — Flash bot (Gemini Flash)

| Turn | Action | Loads | Cash | Route |
|------|--------|-------|------|-------|
| T24 | re-eval | Coal | 2 | pickup(Tobacco@Napoli) → pickup(Marble@Firenze) → deliver(Marble@Leipzig) → deliver(Tobacco@Warszawa) |
| T27 | pickup | Tobacco | 2 | ↑ same route |
| T28 | pickup | Tobacco, Marble | 2 | ↑ same route |
| T30 | move | Tobacco, Marble | 2 | heading to Leipzig (stop 2/4) |
| T31 | deliver | Tobacco, Marble | 24 | **Marble delivered at Leipzig** → card #129 consumed, replaced by card #80. Tobacco→Warszawa demand gone. |
| T32 | move | Tobacco | 24 | heading to Warszawa (stop 3/4) — demand no longer exists |
| T33 | move | Tobacco | 24 | still heading to Warszawa |
| T34 | fail | Tobacco | 24 | `deliver failed (No demand card for "Tobacco" at "Warszawa".). Route abandoned.` |

**Demand cards at turn 30 (pre-delivery):**
- Card #129: Cars→Lisboa 30M, **Tobacco→Warszawa 39M**, **Marble→Leipzig 22M**
- Card #143: Wine→Glasgow 28M, Marble→Goteborg 46M, Cheese→Wroclaw 17M
- Card #4: Copper→Madrid 46M, Cheese→Napoli 23M, Sheep→Nantes 15M

**Demand cards at turn 31 (post-delivery):**
- Card #80 (new): Potatoes→Wien 9M, Oranges→Bruxelles 29M, China→Belfast 15M ← replaced card #129
- Card #143: unchanged
- Card #4: unchanged

**What happened:**
Marble→Leipzig (22M) and Tobacco→Warszawa (39M) are both demands on card #129. The route planned to deliver both. Delivering Marble first consumed card #129, discarding the Tobacco→Warszawa demand. Flash then spent 3 turns hauling Tobacco to Warszawa for a demand that no longer existed. The re-eval at turn 31 even confirmed "Tobacco to Warszawa pays 39M" — but the card was already gone.

## Root Cause Analysis

### 1. Route validator does not check for same-card conflicts

The route planning pipeline allows two DELIVER stops that reference demands on the same `cardIndex`. In EuroRails rules, each demand card has 3 demands — delivering ANY one of them discards the entire card and draws a replacement. A route that delivers two loads from the same card will always fail on the second delivery.

**Where the validation should happen:**
- `RouteValidator` — when validating a planned route, check that no two DELIVER stops reference demands on the same `cardIndex`
- `ResponseParser.parseStrategicRoute()` — or at parse time, cross-reference the delivery stops against demand card indices

### 2. LLM prompt does not communicate card grouping

The LLM sees demands as a flat list. It doesn't know which demands share a card. Without this information, it cannot avoid planning conflicting deliveries. The demand context serialized by `ContextBuilder.serializePrompt()` / `serializeRoutePlanningPrompt()` needs to include `cardIndex` or group demands by card.

### 3. Post-delivery re-eval doesn't revalidate remaining route stops

At turn 31, after delivering Marble, the re-eval LLM call confirmed "Tobacco to Warszawa pays 39M." But the re-eval runs against fresh context (post-delivery snapshot with new demand cards). The demand list at turn 31 no longer includes Tobacco→Warszawa — yet the re-eval either didn't notice or hallucinated its continued existence. The route-executor continued executing the now-invalid stop.

## Proposed Fix

### Validator: reject same-card double delivery

In route validation, cross-reference DELIVER stops against demand cards. If two stops deliver loads that match demands on the same `cardIndex`, reject the route with a clear error message:

```
Route infeasible: deliver(Marble@Leipzig) and deliver(Tobacco@Warszawa) both reference demands on card #129.
Delivering Marble consumes the card, making Tobacco delivery impossible.
```

This is a hard constraint — no valid route can deliver two loads from the same card.

### LLM context: group demands by card

In the serialized prompt, group demands by card so the LLM can see which demands are mutually exclusive:

```
Card #129:
  - Cars: Manchester → Lisboa = 30M
  - Tobacco: OnTrain → Warszawa = 39M
  - Marble: OnTrain → Leipzig = 22M
  (delivering any one discards this card)
```

### Route executor: revalidate after delivery

After a delivery completes and a new demand card is drawn, the route-executor should verify that remaining DELIVER stops still have matching demand cards. If a remaining stop's demand card was consumed, abandon or amend the route immediately rather than continuing to a destination with no demand.

## Impact

- **Wasted turns:** 3 turns (T32-T34) moving Tobacco to Warszawa for nothing
- **Opportunity cost:** Could have delivered Marble→Goteborg (46M on card #143) or pursued card #80 demands
- **The bot chose the lower-value delivery:** Marble→Leipzig (22M) was delivered instead of Tobacco→Warszawa (39M). If the validator had flagged the conflict, the LLM could have chosen the higher-value Tobacco delivery and skipped or dropped Marble.

## Files to Investigate

| File | Relevance |
|------|-----------|
| `src/server/services/ai/RouteValidator.ts` | Add same-card conflict check to route validation |
| `src/server/services/ai/ContextBuilder.ts` | Group demands by cardIndex in serialized prompt |
| `src/server/services/ai/PlanExecutor.ts` | Revalidate remaining stops after delivery |
| `src/server/services/ai/ResponseParser.ts` | Possible parse-time validation |

## Test Scenarios

1. Route with two DELIVER stops on same cardIndex → validation rejects with clear error
2. Route with two DELIVER stops on different cardIndexes → validation passes
3. Route with one DELIVER stop → validation passes (no conflict possible)
4. Post-delivery: remaining DELIVER stop's demand card was consumed → route abandoned/amended
5. LLM prompt includes card grouping so LLM can see mutual exclusivity

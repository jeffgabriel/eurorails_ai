# JIRA-60: Upgrade Advice Should Require Delivery History

## Bug Description

The upgrade recommendation logic (JIRA-55) triggers based solely on train type, turn number, and cash balance — without considering whether the bot has established a working route network with successful deliveries. This causes the bot to be advised to spend 20M on a train upgrade when it should be building track to enable its first deliveries.

## Evidence

Game `ff240679`, Flash (gemini-3-flash-preview):

- Flash had `upgradeAdvice: "You can afford an upgrade (20M)"` from Turn 4 onward
- Flash had 44M cash from T7-T11 but only 1 delivery (Chocolate→Manchester 17M)
- Flash had no established route network — only track from Holland to Manchester via Bruxelles
- Upgrading at this point would leave Flash with 24M and still no route to any supply city for its current demands

The JIRA-55 strong nudge conditions (`Freight && turn >= 15 && money >= 60`) and actionable recommendation (`Freight && turn >= 8 && money >= 30`) don't account for delivery history.

## Current Logic (JIRA-55)

### Part B — Actionable Recommendation
```
Condition: trainType === 'Freight' && turnNumber >= 8 && money >= 30
```

### Part D — Strong Nudge
```
Condition: trainType === 'Freight' && turnNumber >= 15 && money >= 60
```

Neither checks:
- Number of completed deliveries
- Whether the bot has an active, feasible route
- Whether the bot's track network is sufficient for current demands
- Whether 20M would be better spent on track building

## Fix

Add a delivery history gate to upgrade recommendations:

1. **Part B (actionable recommendation)**: Only recommend upgrade if the bot has completed **at least 3 deliveries** (proving the network works and income is flowing)
2. **Part D (strong nudge)**: Only fire strong nudge if the bot has completed **at least 5 deliveries** (bot is well-established but still on Freight)
3. **computeUpgradeAdvice()**: When `deliveryCount < 3`, return advice like "Build track first — upgrade after establishing reliable income" instead of recommending the upgrade

## Affected Files

- `src/server/services/ai/ContextBuilder.ts` — `computeUpgradeAdvice()` and `serializePrompt()` upgrade section (Parts B, C, D from JIRA-55)
- May need to pass `deliveryCount` or `totalDeliveries` into the context or snapshot

## Additional Consideration

The threshold of 2 deliveries is a starting point. A smarter check would be: "has the bot earned enough from deliveries to cover the upgrade cost AND still have building budget?" For example, if total income >= 40M, upgrading at 20M is safe because the bot has proven it can earn.

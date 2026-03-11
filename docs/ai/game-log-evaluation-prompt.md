# Game Log Evaluation Prompt

Use this prompt to evaluate an NDJSON game log. Replace `{GAME_ID}` with the actual game ID.

---

Read the NDJSON game log at `logs/game-{GAME_ID}.ndjson`. Parse every line as JSON. For each bot player in the game, answer the following questions with specific turn numbers and data as evidence.

## 1. Turn Composition Quality

For each bot, evaluate the turn composer output across the full game:

- Were move + pickup + deliver + move + build phases sequenced correctly?
- Were there turns where movement budget was wasted (mileposts left unused)?
- Were there turns where the bot moved but had no pickup/delivery target?
- Were there turns where a pickup or delivery was missed despite the train passing through the relevant city?
- Did the bot ever build track and move in the wrong order (building toward a city it could have reached by moving first)?
- Show the 5 worst turns by wasted movement budget.

## 2. Track Building Efficiency

- List all cities connected by each bot's track network.
- Which connected cities were never visited by the train?
- Which track segments were built but never traversed?
- Was track built toward a destination that was later abandoned (demand discarded or route changed)?
- What was the total track spend vs total income? What percentage of income went to track?
- Were there turns where the bot built fewer segments than the $20M budget allowed? Why?

## 3. Demand Selection and Routing

- For each demand the bot pursued, show: load, supply city, delivery city, payout, estimated turns, actual turns, and whether it was completed.
- Which demands were abandoned (picked up but never delivered, or built toward but never picked up)?
- Were there obviously better demands in hand that were ignored? Show the demand ranking at the time of selection.
- Did the bot ever chase a cross-water demand without accounting for ferry cost?
- Did the bot ever go bankrupt or near-bankrupt ($0-5M) chasing a demand? Which one?

## 4. Income and Economy

- Calculate average income per turn (total payouts / total turns).
- Calculate average income per turn excluding zero-income turns.
- Show income by turn as a simple sparkline or table: turn number, payout, running total cash.
- At what turn did the bot first deliver a load? Was this too late?
- Were there stretches of 5+ turns with zero income? What was the bot doing during those stretches?
- What was the bot's cash at turns 10, 20, 30, 40, 50 (or game end)?

## 5. Movement and Pathfinding

- What was the average mileposts moved per turn vs the train's max capacity?
- Were there turns where the bot moved 0 mileposts despite having movement budget?
- Did the bot pay track usage fees to other players? How much total? Was it worth it (did the route save enough turns)?
- Did the bot ever get stuck in a loop (visiting the same cities repeatedly without delivering)?
- Were there ferry crossings? Were they handled correctly (stop at port, half-rate next turn)?

## 6. Train Upgrades

- What train type did the bot have at each stage of the game?
- Did the bot upgrade? At what turn and cash level?
- Should the bot have upgraded earlier or later? Consider: was the bot movement-constrained (regularly using all mileposts) or cargo-constrained (regularly at load capacity)?
- Did the bot ever consider upgrading but decide not to? Was that the right call?

## 7. Hand Management

- Did the bot discard its hand at any point? Was it the right decision (all 3 demands were poor)?
- Were there stretches where the bot should have discarded but didn't (carrying undeliverable demands for 10+ turns)?
- Show hand quality score over time if available.

## 8. Death Spirals and Stuck Detection

- Did the bot enter a pickup-drop-pickup loop? For how many turns?
- Did the bot fall to $0 cash? What caused it? How long did it stay at $0?
- Did the heuristic fallback activate? For how many consecutive turns? What triggered it (LLM failure, guardrail override, or low cash)?
- Were there guardrail overrides? List each one with turn number and reason.

## 9. Head-to-Head Comparison (if multiple bots)

- Compare each bot on: total deliveries, total income, cash at game end, average income per turn, track segments built, cities connected, major cities connected, train type at game end.
- Which bot made better demand selections? Show the top 3 deliveries by payout for each.
- Which bot had better movement efficiency (mileposts used / mileposts available)?
- Which bot was closer to victory conditions (7 major cities connected + $250M)?

## 10. LLM Interaction Analysis

Evaluate when and how the LLM was consulted during the game:

### Timing Correctness

- Was the LLM called at the correct decision points? Expected triggers include:
  - Game start (starting city and first route selection)
  - After a delivery (new demand card received, re-evaluate route)
  - After a hand discard (3 new demand cards, plan new route)
  - When a route is abandoned or completed (need new strategic direction)
- Was the LLM called at incorrect times? Flag any calls that occurred:
  - Mid-route with no state change (active route, no delivery, no new cards)
  - On consecutive turns with identical game state (wasted LLM calls)
  - During initial build phase (should be heuristic-only)
- Were there decision points where the LLM should have been called but wasn't? (e.g., post-delivery with new demand card but bot continued old route without re-evaluation)

### LLM Request/Response Summary

Show a table of every LLM interaction with columns:

| Turn | Trigger | Question Type | What Was Asked | LLM Response Summary | Response Quality |
|------|---------|--------------|----------------|---------------------|-----------------|

Where:
- **Trigger**: What caused the LLM call (game start, post-delivery, route abandoned, heuristic failure, etc.)
- **Question Type**: route planning, re-evaluation, starting city selection, etc.
- **What Was Asked**: Brief summary of the key context provided (e.g., "3 demands in hand: Coal to Wien 18M, Marble to Paris 25M, Oil to Berlin 15M; bot at München with 45M cash")
- **LLM Response Summary**: Brief summary of the decision (e.g., "Start at Wien, deliver Marble to Paris via München corridor")
- **Response Quality**: Good / Questionable / Bad — with brief justification

### LLM Decision Consistency

- Did the LLM contradict itself across consecutive calls? (e.g., chose route A on turn 5, abandoned it on turn 6 with no state change)
- Did the LLM's route plan match what was actually executed? Show mismatches between planned stops and actual stops.
- Were there LLM parsing failures or malformed responses? How were they handled (retry, heuristic fallback)?
- How many total LLM calls were made? What was the breakdown by type (route planning vs re-evaluation)?

## 11. Suggested Improvements

Based on the full analysis, list concrete improvements to bot logic. For each suggestion:

- Describe the problem observed (with turn numbers).
- Name the file/module responsible.
- Describe the fix or enhancement.
- Estimate the impact (e.g., "would have saved 5 turns and $15M in game X").

Prioritize suggestions by expected impact on win rate.

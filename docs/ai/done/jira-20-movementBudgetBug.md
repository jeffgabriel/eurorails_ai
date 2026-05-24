# JIRA-20: Bot Exceeds Movement Speed Limit

Game: `7e08580c-fd02-4859-bbe2-9e6bfdd0c200`

---

## What Happened

On Turn 16, the bot's Freight train moved **18 mileposts** in a single turn. A Freight is limited to **9 mileposts per turn**.

The bot moved 3 spaces to Warszawa, delivered Steel, then kept moving another 15 spaces west — covering twice the distance allowed by the rules.

| Step | What the bot did | Distance |
|------|-----------------|----------|
| 1 | Moved east to Warszawa | 3mp |
| 2 | Delivered Steel (+19M) | — |
| 3 | Moved west from Warszawa | 6mp |
| 4 | Continued further west | 9mp |
| | **Total movement** | **18mp (limit: 9)** |

## Rule Being Violated

Per EuroRails rules:
- Freight trains move up to **9 mileposts per turn**
- Picking up or delivering a load does **not** cost movement
- But total movement in the turn must stay within the speed limit
- The bot should have stopped after 9 total mileposts of movement

## Why It Happens

When the bot plans a turn with multiple moves (e.g., move to a city, deliver, then move onward), each move segment is treated as if the bot has a fresh full-speed budget. The system correctly limits any *single* move to 9mp, but doesn't track the running total across the whole turn.

So a turn like "move 3mp, deliver, move 9mp" passes validation — each move is individually under 9mp — even though the total (12mp) exceeds the limit.

## Expected Behavior

After the 3mp move to Warszawa and delivery, the bot should have at most **6mp remaining** for the rest of the turn. The continuation move should be truncated to 6mp, and no further movement should be allowed.

## Impact

- Gives the bot an unfair movement advantage over human players
- Allows the bot to cover map distances that should take multiple turns
- Undermines the strategic tradeoff between delivering a load mid-route vs. continuing toward the next destination

## Affected Files

- `ActionResolver.ts` — resolveMultiAction loop doesn't track cumulative movement
- `TurnComposer.ts` — trusts incoming plans without validating total movement
- No validation in GuardrailEnforcer or TurnExecutor either

## How It Was Found

- Observed the bot's train jumping too far in a single turn during gameplay
- Queried the database for all 19 turns of the game
- Computed hex distances for every move step
- Turn 16 was the only violation: 18mp on a 9mp Freight

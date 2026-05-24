# JIRA-203 — Bot locks into PassTurn for the rest of the game when a route's next stop requires building track and the train is already at the build origin

A bot with an active multi-stop route, a carried load, and sufficient cash stops taking productive actions and emits `PassTurn` for the remainder of the game. The bot has a valid build that would advance its current stop, but no build, move, or hand-management action ever fires again.

## Game evidence — `1e87e2aa-b177-4bf4-9a99-8666ab517e71`

Player: **Flash** (gemini-3-flash-preview).

Active route at the moment of lockup (set before T31, unchanged through end of game):
1. pickup Beer @ Frankfurt *(already completed — Beer is in carry)*
2. **pickup Cattle @ Bern** ← `currentStopIndex = 1`
3. deliver Cattle @ London
4. deliver Beer @ Torino

Bern is **not yet on Flash's network** at any point in this sequence. Flash's connected major cities stay frozen at `[Holland, London, Wien]` from T31 onward.

| Turn | Position | Cash | Action | Notes |
|---|---|---|---|---|
| 32 | (30,44) → (36,42) | $60M | MoveTrain | 6 mileposts toward Bern; outputPlan included BuildTrack but build phase produced 0 segments |
| 33 | (36,42) | $60M | **PassTurn** | outputPlan = `[BuildTrack]` only; build resolver listed a candidate that reaches Bern at 4M cost |
| 34 | (36,42) | $60M | **PassTurn** | same — build resolver candidate still present and reachable |
| 35–184 | (36,42) | $60M | **PassTurn** × 150 | identical state every turn |

From T31 to game end at T184, Flash:
- Never moves (`positionEnd` stays at row=36, col=42 for **154 consecutive turns**)
- Never builds (cash stays at exactly $60M for 154 consecutive turns)
- Never delivers, picks up, or drops a load
- Never discards its hand (Flash's `DiscardHand` count for the game is **0**)
- Never declares the route abandoned

The same nine demand cards (cardIndexes 132, 115, 35) are held the entire time. The Beer load remains in carry the entire time.

## What the LLM was doing during the lockup

Flash made **336 LLM calls** across the game — more than any other bot in the run, and most of them during the lockup window. The LLM produced no usable action: the route stays the same, the planner is consulted repeatedly, and the executed action is `PassTurn` every turn.

## Why it matters

This is a hard regression that effectively benches the player. Flash finished with 8 deliveries, $60M cash, 3 of 7 cities, and the lowest income/turn in the game (0.7M vs Haiku's 4.3M and Nano's 3.6M). A bot that hits this lockup cannot win, cannot recover on its own, and degrades head-to-head comparison data because one player's outcome is dominated by a single-state failure rather than strategic choice.

Per the project's North Star, `PassTurn` is the last-resort action; here it has become the default for more than 80% of the bot's turns in the game.

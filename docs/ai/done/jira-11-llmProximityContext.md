# HOLD  JIRA-11: LLM Can't See Which Cities Are Close to the Track Network

## Summary

When the LLM plans a delivery route, it sees each demand card's payout, estimated build cost, and estimated turns. But it doesn't see how close each city is to the bot's existing track. A city one segment away looks nearly the same as a city six segments away — both just show "needs ~XM track." This causes the LLM to propose expensive routes to distant cities when cheap, high-value deliveries are available right next to the existing network.

## What Happens

The bot has track from Ruhr through Berlin and extending toward Beograd (passing near Budapest) and toward München. The demand cards include:

- Beer from München → Torino (18M payout) — Torino is 6+ hexes from the network
- Bauxite from Budapest → München (15M payout) — Budapest is 1 hex from the network

The LLM sees something like:
```
a) Beer: München → Torino (18M) — needs ~17M track, ~4 turns
b) Bauxite: Budapest → München (15M) — needs ~8M track, ~2 turns
```

The LLM picks Beer three times because the payout is higher (18M vs 15M). It doesn't realize that Budapest is literally one segment away — a 3M build that would enable a 15M delivery next turn for a net profit of 12M. Meanwhile Beer requires 17M of track building to reach Torino, making it unaffordable at 11M cash.

## Why This Matters

The most profitable plays in EuroRails are deliveries that use existing track. Zero-cost or near-zero-cost deliveries are pure profit. The LLM's system prompt even says "prefer routes that leverage your existing network" — but the prompt provides no data about what's actually close to the network.

This is especially damaging when the bot is low on cash. A bot with 11M should strongly prefer a 3M build + 15M delivery (net +12M) over a 17M build it can't afford. But without proximity data, the LLM can't make this judgment.

## Example — LLM gets stuck (from live game)

**Bot state:** Position: Berlin. Money: 11M. Track extends near Budapest (1 segment away) and toward München.

**LLM attempt 1:** Beer@München → Beer@Torino. Rejected — needs 17M track, only 11M available.
**LLM attempt 2:** Tries again, response is unparseable (LLM wrote prose instead of structured route).
**LLM attempt 3:** Beer@München → Beer@Torino again. Rejected again.
**Result:** Bot passes turn.

**What the LLM should see:**
```
a) Beer: München → Torino (18M) — Torino is DISTANT (6+ hexes from network, ~17M track)
b) Bauxite: Budapest → München (15M) — Budapest is VERY CLOSE (1 hex from network, ~3M track)
```

With this context, the LLM would immediately recognize that Bauxite is the obvious choice — cheap build, nearby city, good payout, uses existing München track for delivery.

## Example — Proximity changes everything

**Same bot, different demand context:**

Without proximity:
```
Demand A: 18M payout, needs ~17M track, ~4 turns
Demand B: 15M payout, needs ~8M track, ~2 turns
```
The LLM sees two "needs track" routes and leans toward the higher payout.

With proximity:
```
Demand A: 18M payout — delivery city DISTANT (6 hexes from frontier, ~17M track, 2 build turns)
Demand B: 15M payout — supply city VERY CLOSE (1 hex from frontier, ~3M track, 1 build turn)
```
Now the LLM sees that Demand B requires one cheap segment while Demand A requires an expensive multi-turn campaign. The decision is obvious.

## What to Show the LLM

For each demand city that's not on the network, include its distance from the track frontier:

| Distance | Label | Meaning |
|----------|-------|---------|
| 0 | ON YOUR TRACK | Already connected — zero build cost |
| 1-2 hexes | VERY CLOSE | One segment, trivial build |
| 3-5 hexes | NEARBY | Moderate build, 1 turn |
| 6+ hexes | DISTANT | Multi-turn build campaign |

This is already computed internally (`estimateTrackCost` uses hex distance) but never exposed in the prompt. The fix surfaces what the code already knows.

## Manual Test

1. Start a new game. Let the bot play 4-5 turns until it has track built and one delivery completed.
2. After delivery, watch the LLM route planning logs. Note what routes it proposes.
3. Check the board: are there demand cities 1-2 segments from the existing track?
4. Does the LLM pick the nearby city or fixate on a distant higher-payout city?

**Before fix:** The LLM frequently proposes routes to distant cities, ignoring cheap nearby options. Route planning fails when the bot is low on cash because all proposed routes are too expensive.

**After fix:** The LLM should strongly prefer VERY CLOSE and NEARBY cities, especially when cash is low. Route planning failures should drop significantly because the LLM considers proximity when choosing routes.

**Verification:** Run 5 games and count how many times the LLM proposes a route to a DISTANT city when a VERY CLOSE alternative exists. Before fix: common (2-3 per game). After fix: rare (only when the payout difference is overwhelming, e.g., 50M vs 10M).

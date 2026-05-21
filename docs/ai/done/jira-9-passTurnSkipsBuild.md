# HOLD JIRA-9: Bot Passes Turn Instead of Building Track

## Summary

When the LLM can't find a delivery route (all routes too expensive), the bot passes its entire turn — even when it has money and there are useful cities one or two segments away. Per game rules, a player who doesn't move can still build track. The bot should always attempt to build if it has budget remaining, regardless of whether it found an operational action.

## What Happens

The bot delivers a load, earns money, draws a new demand card. The LLM tries to plan a route for the new card but all options require more track than the bot can afford. The LLM gives up and the bot passes its turn.

Meanwhile, one of the demand card cities is a single segment away from the bot's existing track. Building that one segment (cost ~3M) would connect the city and enable a delivery worth 15M+ next turn. But the bot never tries — it just sits there doing nothing.

## Example (from live game)

**Setup:** Bot has Ruhr→Berlin track plus extensions toward Beograd and München. Position: Berlin. Money: 11M. Loads: empty.

**Demand cards include:** Bauxite from Budapest → München (15M). Budapest is one segment from the existing track (the Beograd extension passes right by it).

**What the bot does:** LLM proposes Beer@München→Torino three times. RouteValidator rejects it each time ("need ~17M track, only 11M available"). Bot passes turn. Does nothing.

**What the bot should do:** Even though the LLM couldn't find a full delivery route, the bot should still build track with its remaining budget. Building one segment to Budapest (~3M) connects a supply city and enables the Bauxite delivery next turn.

## Why This Matters

Passing a turn is the worst thing the bot can do (apart from losing money). Every pass is a wasted turn where opponents are delivering, building, and earning. Passing should only happen when the bot truly has no money and no useful action — not when there are cheap builds available.

This is especially painful in the early game when every turn counts.

## Root Cause (behavioral)

The turn composition layer treats "pass turn" as a final, exclusive action — like discarding your hand. When the decision layer says "pass," the composition layer doesn't attempt Phase 2 (build). It returns the pass unchanged.

But "pass" and "discard hand" are different. Discarding your hand IS your entire turn. Passing just means you didn't operate your train — you should still be able to build.

## Manual Test

1. Start a new game with a bot
2. Let the bot play through initial build and 2-3 active turns until it completes a delivery
3. After delivery, watch the next turn — if the LLM can't find a route, the bot will pass
4. Check the board: are there demand cities within 1-3 segments of the bot's track network?
5. **Before fix:** Bot passes, builds nothing
6. **After fix:** Bot builds toward the nearest demand city even when the LLM fails. The turn result should show BuildTrack with the demand city as target. The bot's money should decrease by the build cost.

**Verification:** After the fix, search the server logs for `PassTurn` results. PassTurn should be extremely rare — only when the bot has 0M or every reachable city is already connected. A PassTurn in the first 10 turns of any game is almost certainly a bug.

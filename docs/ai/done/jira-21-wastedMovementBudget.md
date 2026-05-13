# JIRA-21: Bot Wastes Movement Budget After Pickup/Delivery

Game: `7ccf8df7-c397-413a-8375-818eee2c14d5`

---

## What Happened

The bot repeatedly stops moving after picking up or delivering a load, even when it has mileposts left in its movement budget. A Freight train gets 9 mileposts per turn, and loading/unloading is free — but the bot treats arrival at a pickup/delivery city as the end of its movement.

| Turn | What the bot did | Mileposts used | Wasted |
|------|-----------------|----------------|--------|
| 4 | Picked up Flowers at Holland, moved to Bremen (6mp), picked up Machinery — stopped | 6/9 | 3mp |
| 6 | Moved from Berlin to Szczecin (4mp), delivered Machinery — stopped | 4/9 | 5mp |
| 7 | Moved from Szczecin to Leipzig (6mp), picked up China — stopped | 6/9 | 3mp |
| 10 | Moved to Luxembourg (6mp), delivered China, picked up Steel — stopped | 6/9 | 3mp |

Over these 4 turns the bot wasted **14 mileposts** — more than a full turn's worth of movement. On turns 5, 8, 9, 11, and 12, the bot used all 9 mileposts because its destination was far enough away.

## Rule Being Violated

Per EuroRails rules:
- "Picking up or unloading a load does **not** reduce movement"
- "Players may load, unload, and move **in any order** within their movement allowance"
- A human player would pick up at Bremen, then use the remaining 3 mileposts to start heading toward Berlin — cutting a full turn off the trip

## What Should Happen

After picking up or delivering at a city, the bot should continue moving toward its next destination using whatever movement remains. For example on turn 4:

1. Pick up Flowers at Holland (free)
2. Move 6mp to Bremen
3. Pick up Machinery at Bremen (free)
4. **Continue moving 3mp toward Berlin** (next delivery)

Instead the bot stops at step 3 and wastes the remaining 3 mileposts.

## Impact

- The bot takes more turns to complete deliveries than necessary
- A human player would never waste movement this way — it's a fundamental part of efficient play
- Over the course of a game this adds up to multiple wasted turns, making the bot significantly slower and less competitive
- Combined with the build phase that follows movement, the bot falls further behind each turn it doesn't maximize movement

## How It Was Found

- Observed the bot in game `7ccf8df7` not reaching destinations as quickly as expected
- Queried the database for all movement history and turn actions
- Traced the actual paths through the track network to count mileposts
- Confirmed the bot has remaining movement budget on 4 of 9 turns but doesn't use it

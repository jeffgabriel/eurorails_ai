# AI Adversaries

AI bot opponents for EuroRails Online. Bots follow all game rules identically to human players and operate across 3 skill levels and 5 strategy archetypes.

## Documentation

- [Architecture](./architecture.md) - AI pipeline overview, component descriptions, design patterns
- [Shared Types](./shared-types.md) - Type definitions used across the pipeline
- [Bot Audit API](./api-reference/bot-audit.md) - Endpoint for retrieving bot decision data
- [Bot Management API](./api-reference/bot-management.md) - Endpoints for adding/removing bots in lobbies

## Bot Configuration

### Skill Levels

| Level | Behavior |
|-------|----------|
| **Easy** | 20% random choices, 30% suboptimal moves, no lookahead. Suitable for beginners. |
| **Medium** | 5% random, 10% suboptimal, 2-turn lookahead. Balanced challenge. |
| **Hard** | Fully optimal play with 4-turn lookahead. Competitive challenge. |

### Strategy Archetypes

| Archetype | Play Style |
|-----------|------------|
| **Backbone Builder** | Builds a strong interconnected track network connecting major cities |
| **Freight Optimizer** | Maximizes income per move with optimal load combinations |
| **Trunk Sprinter** | Focuses on fast direct routes and early train upgrades |
| **Continental Connector** | Races to connect 7 major cities for victory |
| **Opportunist** | Adapts dynamically, exploiting scarce resources and blocking competitors |

## Strategy Inspector

During a game with bots, players can view bot decision-making through the Strategy Inspector UI:

1. Click the brain icon next to a bot's name in the leaderboard
2. The inspector shows:
   - Current strategy and plan
   - Scored options the bot considered
   - Rejected options with reasons
   - Bot status (cash, train type, loads, cities connected)

### Fast Mode

Toggle "Fast Bot Turns" in Settings to skip animation delays during bot turns.

## Database

### Migration 030

Adds bot support to the database:

- `players.is_bot` (BOOLEAN) - Identifies bot players
- `players.bot_config` (JSONB) - Bot configuration data
- `bot_turn_audits` table - Stores decision audit data per bot turn

## Pipeline Flow

```
BotTurnTrigger
  -> AIStrategyEngine (orchestrator, 3 retries + PassTurn fallback)
    -> WorldSnapshotService (capture immutable game state)
    -> OptionGenerator (generate feasible actions)
    -> Scorer (rank by 12 weighted dimensions)
    -> PlanValidator (validate before execution)
    -> TurnExecutor (execute within DB transaction)
    -> BotAuditService (persist audit for Strategy Inspector)
```

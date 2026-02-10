# Bot Audit API

Endpoints for retrieving bot decision-making data, used by the Strategy Inspector UI.

## GET /api/bot-audit/:gameId/:playerId

Returns the latest `StrategyAudit` for a bot player in a game.

### Authentication

Requires a valid JWT token in the `Authorization` header.

### Authorization

- The requesting user must be a player in the specified game.
- The target `playerId` must be a bot player (`is_bot = true`).

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `gameId` | UUID | The game ID |
| `playerId` | UUID | The bot player ID |

### Response

**200 OK** - Audit found:
```json
{
  "audit": {
    "turnNumber": 5,
    "archetypeName": "Backbone Builder",
    "skillLevel": "medium",
    "currentPlan": "Build toward Munchen for delivery",
    "archetypeRationale": "High cash reserves favor aggressive expansion",
    "feasibleOptions": [
      {
        "type": "BuildTrack",
        "description": "Build 3 segments toward Wien",
        "feasible": true,
        "score": 8.5,
        "rationale": "Strong network expansion value",
        "params": { "segments": [...], "totalCost": 7 }
      }
    ],
    "rejectedOptions": [
      {
        "type": "UpgradeTrain",
        "description": "Upgrade to Fast Freight",
        "feasible": false,
        "reason": "Insufficient funds (need 20, have 15)"
      }
    ],
    "botStatus": {
      "cash": 45,
      "trainType": "Freight",
      "loads": ["Wine"],
      "majorCitiesConnected": 3
    },
    "durationMs": 120
  }
}
```

**200 OK** - No audit data yet:
```json
{
  "audit": null
}
```

**401 Unauthorized** - Missing or invalid token:
```json
{
  "error": "UNAUTHORIZED",
  "message": "Access token required"
}
```

**403 Forbidden** - User is not in the game:
```json
{
  "error": "FORBIDDEN",
  "details": "You are not a player in this game"
}
```

**404 Not Found** - Player is not a bot:
```json
{
  "error": "NOT_FOUND",
  "details": "Bot player not found in this game"
}
```

### Example

```bash
curl -X GET "http://localhost:3000/api/bot-audit/GAME_ID/BOT_PLAYER_ID" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

# Bot Management API

Endpoints for adding and removing bot players in game lobbies.

> **Note:** These endpoints are planned for implementation in upcoming tasks. This document describes the intended API design.

## POST /api/lobby/games/:gameId/bots

Add a bot player to a game lobby.

### Authentication

Requires a valid JWT token. The requesting user must be the game host.

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `gameId` | UUID | The game ID |

### Request Body

```json
{
  "skillLevel": "medium",
  "archetype": "backbone_builder",
  "name": "BuilderBot"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `skillLevel` | string | Yes | `"easy"`, `"medium"`, or `"hard"` |
| `archetype` | string | Yes | One of: `"backbone_builder"`, `"freight_optimizer"`, `"trunk_sprinter"`, `"continental_connector"`, `"opportunist"` |
| `name` | string | No | Display name for the bot (auto-generated if omitted) |

### Response

**201 Created:**
```json
{
  "player": {
    "id": "uuid",
    "name": "BuilderBot",
    "color": "blue",
    "isBot": true,
    "botConfig": {
      "archetype": "backbone_builder",
      "skillLevel": "medium"
    }
  }
}
```

## DELETE /api/lobby/games/:gameId/bots/:playerId

Remove a bot player from a game lobby.

### Authentication

Requires a valid JWT token. The requesting user must be the game host.

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `gameId` | UUID | The game ID |
| `playerId` | UUID | The bot player ID to remove |

### Response

**200 OK:**
```json
{
  "success": true
}
```

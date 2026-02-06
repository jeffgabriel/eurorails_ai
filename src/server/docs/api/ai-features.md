# AI Features API Documentation

## Overview

These endpoints manage AI bot players in EuroRails games. Bots are server-side opponents that use the same game logic as human players, with configurable difficulty and strategic archetypes.

## Authentication

All endpoints require the `x-user-id` header identifying the requesting user. The user must be the game creator (host) to add or remove AI players.

```
x-user-id: 123e4567-e89b-12d3-a456-426614174000
```

---

## Endpoints

### 1. Add AI Player to Game

**POST** `/api/lobby/games/:gameId/ai-player`

Adds an AI bot player to a game lobby. Only the game host can add bots. The game must be in `WAITING` status and not yet at maximum player capacity.

#### URL Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `gameId` | string | UUID of the game |

#### Request Body

```json
{
  "difficulty": "medium",
  "archetype": "backbone_builder",
  "name": "Bot Alice"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `difficulty` | string | Yes | AI skill level: `"easy"`, `"medium"`, or `"hard"` |
| `archetype` | string | Yes | Strategy personality: `"backbone_builder"`, `"freight_optimizer"`, `"trunk_sprinter"`, `"continental_connector"`, or `"opportunist"` |
| `name` | string | No | Display name for the bot. Auto-generated if omitted. |

#### Difficulty Levels

| Level | Description |
|-------|-------------|
| `easy` | Makes suboptimal choices, slower to build network. Good for learning. |
| `medium` | Balanced play with reasonable strategy. Good for casual games. |
| `hard` | Optimized scoring weights, efficient route planning. Challenging opponent. |

#### Archetypes

| Archetype | Strategy |
|-----------|----------|
| `backbone_builder` | Focuses on connecting major cities with efficient trunk lines |
| `freight_optimizer` | Prioritizes high-value deliveries and load management |
| `trunk_sprinter` | Builds fast routes and upgrades train speed early |
| `continental_connector` | Aims to connect all regions of the map |
| `opportunist` | Adapts strategy based on current game state and available demands |

#### Success Response

**Status**: `201 Created`

```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "gameId": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Bot Alice",
    "isAI": true,
    "aiDifficulty": "medium",
    "aiArchetype": "backbone_builder",
    "color": "#FF5733"
  }
}
```

#### Error Responses

| Status | Error Code | Description |
|--------|-----------|-------------|
| 400 | `VALIDATION_ERROR` | Invalid difficulty, archetype, or request body |
| 403 | `NOT_GAME_CREATOR` | Only the game host can add AI players |
| 404 | `GAME_NOT_FOUND` | Game does not exist |
| 409 | `GAME_FULL` | Game has reached maximum player capacity |
| 409 | `GAME_ALREADY_STARTED` | Cannot add players to a game in progress |

#### Example

```bash
curl -X POST http://localhost:3000/api/lobby/games/550e8400-e29b-41d4-a716-446655440000/ai-player \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{
    "difficulty": "medium",
    "archetype": "backbone_builder",
    "name": "Bot Alice"
  }'
```

---

### 2. Remove AI Player from Game

**DELETE** `/api/lobby/games/:gameId/ai-player/:playerId`

Removes an AI bot from a game lobby. Only the game host can remove bots. The game must be in `WAITING` status.

#### URL Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `gameId` | string | UUID of the game |
| `playerId` | string | UUID of the AI player to remove |

#### Success Response

**Status**: `200 OK`

```json
{
  "success": true,
  "message": "AI player removed"
}
```

#### Error Responses

| Status | Error Code | Description |
|--------|-----------|-------------|
| 403 | `NOT_GAME_CREATOR` | Only the game host can remove AI players |
| 404 | `GAME_NOT_FOUND` | Game does not exist |
| 404 | `PLAYER_NOT_FOUND` | AI player not found in this game |
| 409 | `GAME_ALREADY_STARTED` | Cannot remove players from a game in progress |

#### Example

```bash
curl -X DELETE http://localhost:3000/api/lobby/games/550e8400-e29b-41d4-a716-446655440000/ai-player/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000"
```

---

### 3. Get AI Strategy Audit

**GET** `/api/games/:gameId/ai-audit/:playerId`

Returns the strategy audit for an AI player's most recent turn. The audit includes the options considered, scores, the selected plan, and execution results. This powers the Strategy Inspector UI.

#### URL Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `gameId` | string | UUID of the game |
| `playerId` | string | UUID of the AI player |

#### Success Response

**Status**: `200 OK`

```json
{
  "success": true,
  "data": {
    "snapshotHash": "abc123def456",
    "allOptions": [
      {
        "id": "opt-1",
        "type": "DeliverLoad",
        "parameters": {
          "loadType": "Coal",
          "destinationCity": "Berlin",
          "demandCardId": "card-42"
        },
        "score": 85.5,
        "feasible": true,
        "rejectionReason": null
      },
      {
        "id": "opt-2",
        "type": "BuildTrack",
        "parameters": {
          "from": { "row": 10, "col": 5 },
          "to": { "row": 10, "col": 6 }
        },
        "score": 42.0,
        "feasible": true,
        "rejectionReason": null
      },
      {
        "id": "opt-3",
        "type": "PickupAndDeliver",
        "parameters": {
          "pickupCity": "Paris",
          "loadType": "Wine",
          "destinationCity": "London"
        },
        "score": 0,
        "feasible": false,
        "rejectionReason": "No path to Paris on built track"
      }
    ],
    "scores": [85.5, 42.0, 0],
    "selectedPlan": {
      "actions": [
        {
          "type": "DeliverLoad",
          "parameters": {
            "loadType": "Coal",
            "destinationCity": "Berlin",
            "demandCardId": "card-42"
          }
        }
      ],
      "expectedOutcome": {
        "cashChange": 12,
        "loadsDelivered": 1,
        "trackSegmentsBuilt": 0,
        "newMajorCitiesConnected": 0
      },
      "totalScore": 85.5,
      "archetype": "freight_optimizer",
      "skillLevel": "medium"
    },
    "executionResults": [
      {
        "actionType": "DeliverLoad",
        "success": true,
        "durationMs": 45
      }
    ],
    "timing": {
      "snapshotMs": 12,
      "optionGenerationMs": 150,
      "scoringMs": 35,
      "executionMs": 45,
      "totalMs": 242
    }
  }
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `snapshotHash` | string | Hash of the game state snapshot used for planning |
| `allOptions` | array | All candidate actions generated, both feasible and rejected |
| `allOptions[].type` | string | Action type: `DeliverLoad`, `PickupAndDeliver`, `BuildTrack`, `UpgradeTrain`, `BuildTowardMajorCity`, `PassTurn` |
| `allOptions[].score` | number | Heuristic score (higher is better). 0 for infeasible options. |
| `allOptions[].feasible` | boolean | Whether the action passed validation |
| `allOptions[].rejectionReason` | string or null | Why the option was rejected, if infeasible |
| `scores` | array | Score values in same order as `allOptions` |
| `selectedPlan` | object | The plan that was executed |
| `selectedPlan.archetype` | string | Bot's strategy archetype |
| `selectedPlan.skillLevel` | string | Bot's difficulty level |
| `executionResults` | array | Outcome of each executed action |
| `timing` | object | Performance breakdown in milliseconds |

#### Error Responses

| Status | Error Code | Description |
|--------|-----------|-------------|
| 404 | `GAME_NOT_FOUND` | Game does not exist |
| 404 | `PLAYER_NOT_FOUND` | Player not found or is not an AI player |
| 404 | `NOT_FOUND` | No audit data available (bot has not taken a turn yet) |

#### Example

```bash
curl http://localhost:3000/api/games/550e8400-e29b-41d4-a716-446655440000/ai-audit/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000"
```

---

## Type Reference

These types are defined in `src/shared/types/AITypes.ts`.

### AIDifficulty

```typescript
type AIDifficulty = 'easy' | 'medium' | 'hard';
```

### AIArchetype

```typescript
type AIArchetype =
  | 'backbone_builder'
  | 'freight_optimizer'
  | 'trunk_sprinter'
  | 'continental_connector'
  | 'opportunist';
```

### AIPlayerConfig

```typescript
interface AIPlayerConfig {
  difficulty: AIDifficulty;
  archetype: AIArchetype;
  name?: string;
}
```

### AIActionType

```typescript
enum AIActionType {
  DeliverLoad = 'DeliverLoad',
  PickupAndDeliver = 'PickupAndDeliver',
  BuildTrack = 'BuildTrack',
  UpgradeTrain = 'UpgradeTrain',
  BuildTowardMajorCity = 'BuildTowardMajorCity',
  PassTurn = 'PassTurn',
}
```

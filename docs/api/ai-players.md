# AI Player Management API

This document describes the API endpoints for managing AI players in EuroRails single-player mode.

## Overview

AI players (bots) can be added to game lobbies to enable single-player or mixed human/AI gameplay. Each AI player has two configurable attributes:

- **Difficulty**: Controls how sophisticated the AI's planning is (easy, medium, hard)
- **Personality**: Determines the AI's playstyle and strategic priorities

### Type Definitions

```typescript
type AIDifficulty = 'easy' | 'medium' | 'hard';

type AIPersonality =
  | 'optimizer'        // Maximizes ROI per action
  | 'network_builder'  // Infrastructure-first approach
  | 'opportunist'      // Chases best available opportunities
  | 'blocker'          // Focuses on denying opponents
  | 'steady_hand'      // Consistent, low-risk progress
  | 'chaos_agent';     // Unpredictable decisions
```

---

## Endpoints

### Add AI Player to Lobby

Adds an AI player to a game lobby. Only the game creator can add AI players.

```
POST /api/lobby/games/:gameId/ai-player
```

#### Path Parameters

| Parameter | Type   | Required | Description                    |
|-----------|--------|----------|--------------------------------|
| `gameId`  | string | Yes      | UUID of the game to add AI to  |

#### Request Headers

| Header          | Type   | Required | Description                          |
|-----------------|--------|----------|--------------------------------------|
| `Authorization` | string | Yes      | Bearer token for authentication      |
| `Content-Type`  | string | Yes      | Must be `application/json`           |

#### Request Body

| Field         | Type            | Required | Description                              |
|---------------|-----------------|----------|------------------------------------------|
| `difficulty`  | `AIDifficulty`  | Yes      | AI skill level: `easy`, `medium`, `hard` |
| `personality` | `AIPersonality` | Yes      | AI playstyle personality                 |

```json
{
  "difficulty": "medium",
  "personality": "optimizer"
}
```

#### Response

**Success (201 Created)**

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "userId": null,
    "name": "Bot 1 (Medium Optimizer)",
    "color": "#FFD700",
    "isOnline": true,
    "isAI": true,
    "aiDifficulty": "medium",
    "aiPersonality": "optimizer"
  }
}
```

#### Error Responses

| Status | Error Code            | Description                                      |
|--------|-----------------------|--------------------------------------------------|
| 400    | `VALIDATION_ERROR`    | Invalid difficulty or personality value          |
| 401    | `UNAUTHORIZED`        | Missing or invalid authentication token          |
| 403    | `FORBIDDEN`           | User is not the game creator                     |
| 404    | `GAME_NOT_FOUND`      | Game with the specified ID does not exist        |
| 409    | `GAME_FULL`           | Maximum player limit (6) reached                 |
| 409    | `GAME_ALREADY_STARTED`| Cannot add AI to a game that has already started |

**Example Error Response:**

```json
{
  "error": "GAME_FULL",
  "message": "Cannot add AI player: game has reached maximum players",
  "details": "Maximum 6 players allowed (humans + AI combined)"
}
```

#### Example Request

```bash
curl -X POST "https://api.example.com/api/lobby/games/550e8400-e29b-41d4-a716-446655440000/ai-player" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d '{
    "difficulty": "medium",
    "personality": "optimizer"
  }'
```

**TypeScript Example:**

```typescript
const response = await fetch(
  `${API_BASE_URL}/api/lobby/games/${gameId}/ai-player`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      difficulty: 'medium',
      personality: 'optimizer',
    }),
  }
);

const result = await response.json();
// result.data contains the Player object
```

---

### Remove AI Player from Lobby

Removes an AI player from a game lobby. Only the game creator can remove AI players.

```
DELETE /api/lobby/games/:gameId/ai-player/:playerId
```

#### Path Parameters

| Parameter  | Type   | Required | Description                         |
|------------|--------|----------|-------------------------------------|
| `gameId`   | string | Yes      | UUID of the game                    |
| `playerId` | string | Yes      | UUID of the AI player to remove     |

#### Request Headers

| Header          | Type   | Required | Description                     |
|-----------------|--------|---------|---------------------------------|
| `Authorization` | string | Yes      | Bearer token for authentication |

#### Response

**Success (200 OK)**

```json
{
  "success": true,
  "message": "AI player removed successfully"
}
```

#### Error Responses

| Status | Error Code            | Description                                         |
|--------|-----------------------|-----------------------------------------------------|
| 401    | `UNAUTHORIZED`        | Missing or invalid authentication token             |
| 403    | `FORBIDDEN`           | User is not the game creator                        |
| 404    | `GAME_NOT_FOUND`      | Game with the specified ID does not exist           |
| 404    | `PLAYER_NOT_FOUND`    | AI player with the specified ID does not exist      |
| 409    | `GAME_ALREADY_STARTED`| Cannot remove AI from a game that has started       |

**Example Error Response:**

```json
{
  "error": "PLAYER_NOT_FOUND",
  "message": "AI player not found",
  "details": "No AI player found with the provided ID in this game"
}
```

#### Example Request

```bash
curl -X DELETE "https://api.example.com/api/lobby/games/550e8400-e29b-41d4-a716-446655440000/ai-player/550e8400-e29b-41d4-a716-446655440001" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**TypeScript Example:**

```typescript
const response = await fetch(
  `${API_BASE_URL}/api/lobby/games/${gameId}/ai-player/${playerId}`,
  {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  }
);

const result = await response.json();
// result.success === true on success
```

---

### Get AI Player Status

Retrieves the current strategy and last turn summary for an AI player during gameplay.

```
GET /api/games/:gameId/ai-status/:playerId
```

#### Path Parameters

| Parameter  | Type   | Required | Description                    |
|------------|--------|----------|--------------------------------|
| `gameId`   | string | Yes      | UUID of the game               |
| `playerId` | string | Yes      | UUID of the AI player          |

#### Request Headers

| Header          | Type   | Required | Description                     |
|-----------------|--------|---------|---------------------------------|
| `Authorization` | string | Yes      | Bearer token for authentication |

#### Response

**Success (200 OK)**

```json
{
  "success": true,
  "data": {
    "currentStrategy": {
      "phase": "network_expansion",
      "currentGoal": "Connect to Warszawa",
      "nextGoal": "Deliver Machinery to Berlin",
      "majorCityProgress": "4/7",
      "cashToWin": 127
    },
    "lastTurnSummary": {
      "actions": [
        {
          "type": "build",
          "description": "Built track from München to Wien",
          "details": {
            "cost": 7,
            "roi": 3.2
          }
        },
        {
          "type": "deliver",
          "description": "Delivered Machinery to Berlin",
          "details": {
            "payout": 18,
            "loadType": "machinery"
          }
        }
      ],
      "cashChange": 11,
      "commentary": "Prioritizing eastern corridor. 3 demands achievable within 4 turns."
    }
  }
}
```

#### Response Schema

**AIStrategy Object:**

| Field               | Type   | Description                                    |
|---------------------|--------|------------------------------------------------|
| `phase`             | string | Current strategic phase                        |
| `currentGoal`       | string | What the AI is currently working toward        |
| `nextGoal`          | string | The AI's next planned objective                |
| `majorCityProgress` | string | Progress toward 7-city victory condition       |
| `cashToWin`         | number | ECU millions needed to reach victory threshold |

**TurnSummary Object:**

| Field        | Type     | Description                              |
|--------------|----------|------------------------------------------|
| `actions`    | Action[] | Array of actions taken during the turn   |
| `cashChange` | number   | Net change in cash during the turn (ECU) |
| `commentary` | string   | Personality-driven explanation of turn   |

**Action Object:**

| Field         | Type   | Description                                         |
|---------------|--------|-----------------------------------------------------|
| `type`        | string | Action type: `build`, `move`, `pickup`, `deliver`, `drop` |
| `description` | string | Human-readable description of the action            |
| `details`     | object | Action-specific details (varies by type)            |

#### Error Responses

| Status | Error Code         | Description                                     |
|--------|--------------------|-------------------------------------------------|
| 401    | `UNAUTHORIZED`     | Missing or invalid authentication token         |
| 404    | `GAME_NOT_FOUND`   | Game with the specified ID does not exist       |
| 404    | `PLAYER_NOT_FOUND` | Player with the specified ID does not exist     |
| 404    | `NOT_AI_PLAYER`    | The specified player is not an AI player        |

**Example Error Response:**

```json
{
  "error": "NOT_AI_PLAYER",
  "message": "Player is not an AI player",
  "details": "AI status is only available for AI-controlled players"
}
```

#### Example Request

```bash
curl -X GET "https://api.example.com/api/games/550e8400-e29b-41d4-a716-446655440000/ai-status/550e8400-e29b-41d4-a716-446655440001" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**TypeScript Example:**

```typescript
const response = await fetch(
  `${API_BASE_URL}/api/games/${gameId}/ai-status/${playerId}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  }
);

const result = await response.json();
// result.data.currentStrategy - AI's current strategic state
// result.data.lastTurnSummary - Summary of last turn actions
```

---

## Difficulty Levels

| Difficulty | Planning Horizon  | Decision Quality                     |
|------------|-------------------|--------------------------------------|
| `easy`     | Current turn only | Satisficing (first good option)      |
| `medium`   | 2-3 turns ahead   | Good (top 3 options evaluated)       |
| `hard`     | 4-5 turns ahead   | Optimal (exhaustive evaluation)      |

## Personalities

| Personality       | Strategy                         | Risk Tolerance |
|-------------------|----------------------------------|----------------|
| `optimizer`       | Maximize ROI per action          | Low            |
| `network_builder` | Infrastructure first             | Medium         |
| `opportunist`     | Chase best available opportunity | High           |
| `blocker`         | Deny opponents                   | Medium         |
| `steady_hand`     | Consistent, safe progress        | Very Low       |
| `chaos_agent`     | Unpredictable decisions          | Variable       |

---

## Socket Events

In addition to the REST API, AI player actions are broadcast via WebSocket:

### `ai:thinking`

Emitted when an AI player starts their turn.

```typescript
{
  playerId: string;
}
```

### `ai:turn-complete`

Emitted when an AI player completes their turn, containing the same data as the GET ai-status endpoint.

```typescript
{
  playerId: string;
  turnSummary: TurnSummary;
  currentStrategy: AIStrategy;
  debug?: {
    routesEvaluated: number;
    selectedRouteScore: number;
    decisionTimeMs: number;
    variablesConsidered: string[];
  };
}
```

---

## Related Endpoints

- `GET /api/lobby/games/:gameId/players` - List all players (human + AI) in a game
- `POST /api/lobby/games/:gameId/start` - Start a game (works with AI players)

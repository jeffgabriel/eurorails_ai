# Lobby API Documentation

## Overview
This document provides comprehensive documentation for the Lobby API endpoints. The API enables game creation, player management, and lobby operations for the EuroRails AI game.

## Base URL
```
http://localhost:3000/api/lobby
```

## Authentication
Currently, user identification is handled via the `x-user-id` header or by providing `userId` in request bodies. Future versions will implement proper authentication.

## Request/Response Format
All requests and responses use JSON format with the following structure:

### Success Response
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional success message"
}
```

### Error Response
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable error message",
  "details": "Additional error details"
}
```

## Error Codes
- `VALIDATION_ERROR` - Invalid input data
- `GAME_NOT_FOUND` - Game does not exist
- `GAME_FULL` - Game has reached maximum capacity
- `GAME_ALREADY_STARTED` - Game is already in progress
- `INVALID_JOIN_CODE` - Invalid or expired join code
- `NOT_GAME_CREATOR` - User is not the game creator
- `INSUFFICIENT_PLAYERS` - Not enough players to start game
- `PLAYER_NOT_IN_GAME` - Player is not in the specified game
- `PLAYER_NOT_FOUND` - Player does not exist
- `NOT_FOUND` - Resource not found

---

## Endpoints

### 1. Create Game
**POST** `/games`

Creates a new game lobby with a unique join code.

#### Request Body
```json
{
  "isPublic": boolean,        // Optional: Whether game is public (default: false)
  "maxPlayers": number,       // Optional: Maximum players (2-6, default: 4)
  "createdByUserId": string   // Optional: Creator's user ID (or use x-user-id header)
}
```

#### Response
**Status**: `201 Created`
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "joinCode": "ABC12345",
    "createdBy": "uuid",
    "maxPlayers": 4,
    "isPublic": false,
    "status": "WAITING",
    "createdAt": "2025-09-13T00:00:00.000Z",
    "updatedAt": "2025-09-13T00:00:00.000Z"
  }
}
```

#### Example
```bash
curl -X POST http://localhost:3000/api/lobby/games \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{
    "isPublic": true,
    "maxPlayers": 6
  }'
```

---

### 2. Join Game
**POST** `/games/join`

Joins an existing game using a join code.

#### Request Body
```json
{
  "joinCode": "string",       // Required: 8-character join code
  "userId": string            // Optional: User ID (or use x-user-id header)
}
```

#### Response
**Status**: `200 OK`
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "joinCode": "ABC12345",
    "createdBy": "uuid",
    "maxPlayers": 4,
    "isPublic": false,
    "status": "WAITING",
    "createdAt": "2025-09-13T00:00:00.000Z",
    "updatedAt": "2025-09-13T00:00:00.000Z"
  }
}
```

#### Example
```bash
curl -X POST http://localhost:3000/api/lobby/games/join \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{
    "joinCode": "ABC12345"
  }'
```

---

### 3. Get Game Information
**GET** `/games/:id`

Retrieves information about a specific game.

#### Path Parameters
- `id` (string, required) - Game UUID

#### Response
**Status**: `200 OK`
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "joinCode": "ABC12345",
    "createdBy": "uuid",
    "maxPlayers": 4,
    "isPublic": false,
    "status": "WAITING",
    "createdAt": "2025-09-13T00:00:00.000Z",
    "updatedAt": "2025-09-13T00:00:00.000Z"
  }
}
```

**Status**: `404 Not Found`
```json
{
  "error": "GAME_NOT_FOUND",
  "message": "Game not found",
  "details": "No game found with the provided ID"
}
```

#### Example
```bash
curl -X GET http://localhost:3000/api/lobby/games/123e4567-e89b-12d3-a456-426614174000
```

---

### 4. Get Game Players
**GET** `/games/:id/players`

Retrieves all players currently in a game.

#### Path Parameters
- `id` (string, required) - Game UUID

#### Response
**Status**: `200 OK`
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "Player 1",
      "color": "#FF0000",
      "money": 50,
      "trainType": "Freight",
      "turnNumber": 1,
      "isOnline": true,
      "createdAt": "2025-09-13T00:00:00.000Z"
    }
  ]
}
```

#### Example
```bash
curl -X GET http://localhost:3000/api/lobby/games/123e4567-e89b-12d3-a456-426614174000/players
```

---

### 5. Start Game
**POST** `/games/:id/start`

Starts a game (changes status from WAITING to ACTIVE).

#### Path Parameters
- `id` (string, required) - Game UUID

#### Request Body
```json
{
  "creatorUserId": string     // Optional: Creator's user ID (or use x-user-id header)
}
```

#### Response
**Status**: `200 OK`
```json
{
  "success": true,
  "message": "Game started successfully"
}
```

**Status**: `400 Bad Request`
```json
{
  "error": "INSUFFICIENT_PLAYERS",
  "message": "Not enough players to start game",
  "details": "At least 2 players required to start"
}
```

#### Example
```bash
curl -X POST http://localhost:3000/api/lobby/games/123e4567-e89b-12d3-a456-426614174000/start \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{}'
```

---

### 6. Leave Game
**POST** `/games/:id/leave`

Removes a player from a game.

#### Path Parameters
- `id` (string, required) - Game UUID

#### Request Body
```json
{
  "userId": string           // Optional: User ID (or use x-user-id header)
}
```

#### Response
**Status**: `200 OK`
```json
{
  "success": true,
  "message": "Left game successfully"
}
```

**Status**: `404 Not Found`
```json
{
  "error": "PLAYER_NOT_IN_GAME",
  "message": "Player not found in this game",
  "details": "Player is not currently in the specified game"
}
```

#### Example
```bash
curl -X POST http://localhost:3000/api/lobby/games/123e4567-e89b-12d3-a456-426614174000/leave \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{}'
```

---

### 7. Update Player Presence
**POST** `/players/presence`

Updates a player's online/offline status.

#### Request Body
```json
{
  "userId": string,          // Optional: User ID (or use x-user-id header)
  "isOnline": boolean        // Required: Online status
}
```

#### Response
**Status**: `200 OK`
```json
{
  "success": true,
  "message": "Player presence updated successfully"
}
```

**Status**: `404 Not Found`
```json
{
  "error": "PLAYER_NOT_FOUND",
  "message": "Player not found",
  "details": "No player found with the provided ID"
}
```

#### Example
```bash
curl -X POST http://localhost:3000/api/lobby/players/presence \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{
    "isOnline": true
  }'
```

---

### 8. Health Check
**GET** `/health`

Checks the health status of the lobby service.

#### Response
**Status**: `200 OK`
```json
{
  "success": true,
  "message": "Lobby service is healthy",
  "timestamp": "2025-09-13T00:00:00.000Z",
  "service": "lobby-api"
}
```

#### Example
```bash
curl -X GET http://localhost:3000/api/lobby/health
```

---

## Data Models

### Game Object
```typescript
interface Game {
  id: string;                    // UUID
  joinCode: string;              // 8-character alphanumeric code
  createdBy: string;             // Creator's user ID
  maxPlayers: number;            // Maximum players (2-6)
  isPublic: boolean;             // Whether game is publicly visible
  status: 'WAITING' | 'ACTIVE';  // Game status
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
}
```

### Player Object
```typescript
interface Player {
  id: string;                    // UUID
  name: string;                  // Player display name
  color: string;                 // Hex color code
  money: number;                 // Starting money
  trainType: string;             // Train type (Freight, Fast Freight, etc.)
  turnNumber: number;            // Turn order
  isOnline: boolean;             // Online status
  createdAt: string;             // ISO timestamp
}
```

---

## Rate Limiting
Currently, no rate limiting is implemented. Future versions will include rate limiting to prevent abuse.

## CORS
CORS is configured to allow requests from the frontend application. The allowed origins are configured in the Express application.

## Logging
All API requests are logged with:
- Request ID for tracing
- Request method and URL
- Response status and duration
- Error details (if applicable)

## Testing
The API includes comprehensive test coverage:
- **Unit Tests**: 43 tests for service layer
- **Integration Tests**: 13 tests for API workflows
- **HTTP Tests**: 24 tests for actual HTTP endpoints

Run tests with:
```bash
npm test
```

---

## Changelog

### Version 1.0.0 (2025-09-13)
- Initial API implementation
- Complete lobby functionality
- Comprehensive error handling
- Request logging and monitoring
- Full test coverage

---

## Support
For issues or questions regarding the Lobby API, please refer to the project documentation or create an issue in the repository.

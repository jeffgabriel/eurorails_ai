# EuroRails API Documentation

This directory contains API documentation for the EuroRails game server.

## Endpoints

### Authentication
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login and get JWT token
- `GET /api/auth/me` - Get current user info
- `POST /api/auth/refresh` - Refresh access token

### Lobby Management
- `POST /api/lobby/games` - Create a new game
- `POST /api/lobby/games/join` - Join a game by code
- `GET /api/lobby/games/:id` - Get game details
- `GET /api/lobby/games/:id/players` - Get game players
- `GET /api/lobby/games/:id/available-colors` - Get available player colors
- `POST /api/lobby/games/:id/start` - Start a game
- `POST /api/lobby/games/:id/leave` - Leave a game
- `GET /api/lobby/my-games` - List user's games

### AI Player Management
- [AI Players API](./ai-players.md) - Complete documentation for AI player endpoints
  - `POST /api/lobby/games/:gameId/ai-player` - Add AI player to lobby
  - `DELETE /api/lobby/games/:gameId/ai-player/:playerId` - Remove AI player
  - `GET /api/games/:gameId/ai-status/:playerId` - Get AI player status

### Game State
- `GET /api/games/:id` - Get full game state
- `POST /api/games/:id/actions` - Submit game action

### Loads
- `GET /api/loads/state` - Get load availability state
- `GET /api/loads/dropped` - Get dropped loads
- `POST /api/loads/pickup` - Pick up a load
- `POST /api/loads/return` - Return a load

## Authentication

Most endpoints require a JWT token in the Authorization header:

```
Authorization: Bearer <token>
```

Tokens are obtained via `/api/auth/login` and can be refreshed via `/api/auth/refresh`.

## Response Format

All endpoints follow a standard response format:

**Success:**
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional success message"
}
```

**Error:**
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable error description",
  "details": "Optional additional details"
}
```

## Common Error Codes

| Code                   | HTTP Status | Description                    |
|------------------------|-------------|--------------------------------|
| `UNAUTHORIZED`         | 401         | Missing or invalid token       |
| `FORBIDDEN`            | 403         | Not allowed to perform action  |
| `GAME_NOT_FOUND`       | 404         | Game does not exist            |
| `PLAYER_NOT_FOUND`     | 404         | Player does not exist          |
| `VALIDATION_ERROR`     | 400         | Invalid request data           |
| `GAME_FULL`            | 409         | Game at max player capacity    |
| `GAME_ALREADY_STARTED` | 409         | Game has already started       |

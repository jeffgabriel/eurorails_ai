# Lobby API Quick Reference

## Base URL
```
http://localhost:3000/api/lobby
```

## Headers
```bash
Content-Type: application/json
x-user-id: <user-uuid>
```

---

## 🎮 Game Management

### Create Game
```bash
POST /games
{
  "isPublic": boolean,     # Optional (default: false)
  "maxPlayers": number,    # Optional (2-6, default: 4)
  "createdByUserId": uuid  # Optional (or use header)
}
```
**Response**: `201` - Game object with joinCode

### Join Game
```bash
POST /games/join
{
  "joinCode": "ABC12345",  # Required (8 chars)
  "userId": uuid          # Optional (or use header)
}
```
**Response**: `200` - Game object

### Get Game
```bash
GET /games/{id}
```
**Response**: `200` - Game object

### Get Players
```bash
GET /games/{id}/players
```
**Response**: `200` - Array of Player objects

### Start Game
```bash
POST /games/{id}/start
{
  "creatorUserId": uuid    # Optional (or use header)
}
```
**Response**: `200` - Success message

### Leave Game
```bash
POST /games/{id}/leave
{
  "userId": uuid          # Optional (or use header)
}
```
**Response**: `200` - Success message

---

## 👤 Player Management

### Update Presence
```bash
POST /players/presence
{
  "userId": uuid,         # Optional (or use header)
  "isOnline": boolean     # Required
}
```
**Response**: `200` - Success message

---

## 🔍 System

### Health Check
```bash
GET /health
```
**Response**: `200` - Service status

---

## 📊 Data Models

### Game
```typescript
{
  id: string,              // UUID
  joinCode: string,        // 8-char code
  createdBy: string,       // Creator UUID
  maxPlayers: number,      // 2-6
  isPublic: boolean,       // Visibility
  status: "WAITING" | "ACTIVE",
  createdAt: string,       // ISO timestamp
  updatedAt: string        // ISO timestamp
}
```

### Player
```typescript
{
  id: string,              // UUID
  name: string,            // Display name
  color: string,           // Hex color
  money: number,           // Starting money
  trainType: string,       // Train type
  turnNumber: number,      // Turn order
  isOnline: boolean,       // Online status
  createdAt: string        // ISO timestamp
}
```

---

## ❌ Error Codes

| Code | Description |
|------|-------------|
| `VALIDATION_ERROR` | Invalid input data |
| `GAME_NOT_FOUND` | Game doesn't exist |
| `GAME_FULL` | Game at capacity |
| `GAME_ALREADY_STARTED` | Game in progress |
| `INVALID_JOIN_CODE` | Bad join code |
| `NOT_GAME_CREATOR` | Not authorized |
| `INSUFFICIENT_PLAYERS` | Need more players |
| `PLAYER_NOT_IN_GAME` | Player not in game |
| `PLAYER_NOT_FOUND` | Player doesn't exist |
| `NOT_FOUND` | Resource not found |

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --testPathPattern=lobbyRoutes

# Run with coverage
npm test -- --coverage
```

---

## 📝 Examples

### Complete Workflow
```bash
# 1. Create game
curl -X POST http://localhost:3000/api/lobby/games \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{"isPublic": true, "maxPlayers": 4}'

# 2. Join game (use joinCode from step 1)
curl -X POST http://localhost:3000/api/lobby/games/join \
  -H "Content-Type: application/json" \
  -H "x-user-id: 987fcdeb-51a2-43d1-b456-426614174000" \
  -d '{"joinCode": "ABC12345"}'

# 3. Start game
curl -X POST http://localhost:3000/api/lobby/games/{game-id}/start \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{}'
```

---

## 🔗 Links

- [Full API Documentation](./API_DOCUMENTATION.md)
- [OpenAPI Specification](./openapi.yaml)
- [Interactive Docs](https://editor.swagger.io/) (paste openapi.yaml)

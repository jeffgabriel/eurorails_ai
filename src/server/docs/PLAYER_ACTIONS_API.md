# Player Actions API Documentation

## Overview
This document provides documentation for the Player Actions API endpoints. These endpoints handle in-game player actions including borrowing money (Mercy Rule), delivering loads, and other player-related operations.

## Base URL
```
http://localhost:3001/api/players
```

## Authentication
All endpoints require JWT Bearer token authentication using the `Authorization` header.

```
Authorization: Bearer <JWT_TOKEN>
```

## Request/Response Format
All requests and responses use JSON format.

### Success Response
```json
{
  "fieldName": "value",
  ...
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
- `UNAUTHORIZED` - Missing or invalid JWT token
- `Validation error` - Invalid input data
- `Not your turn` - Action attempted when not player's turn
- `Player not found in game` - Player does not exist in the specified game

---

## Endpoints

### 1. Borrow Money (Mercy Rule)
**POST** `/borrow`

Allows a player to borrow money from the bank as part of the Mercy Rule. The player must repay double the borrowed amount from future delivery payoffs.

#### Authentication
- **Required**: Yes (JWT Bearer token)

#### Authorization
- Player must exist in the specified game
- It must be the player's turn

#### Request Body
| Field | Type | Required | Description | Constraints |
|-------|------|----------|-------------|-------------|
| `gameId` | string | Yes | UUID of the game | Valid UUID |
| `amount` | number | Yes | Amount to borrow in ECU | Integer, 1-20 |

```json
{
  "gameId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "amount": 10
}
```

#### Success Response
**Status**: `200 OK`

| Field | Type | Description |
|-------|------|-------------|
| `borrowedAmount` | number | Amount borrowed (same as request) |
| `debtIncurred` | number | Amount added to debt (2x borrowed amount) |
| `updatedMoney` | number | New player money balance |
| `updatedDebtOwed` | number | New total debt owed |

```json
{
  "borrowedAmount": 10,
  "debtIncurred": 20,
  "updatedMoney": 60,
  "updatedDebtOwed": 20
}
```

#### Error Responses

**Status**: `400 Bad Request` - Invalid amount
```json
{
  "error": "Validation error",
  "details": "Amount must be between 1 and 20"
}
```

**Status**: `400 Bad Request` - Invalid amount type
```json
{
  "error": "Validation error",
  "details": "Amount must be an integer"
}
```

**Status**: `401 Unauthorized` - Missing or invalid token
```json
{
  "error": "UNAUTHORIZED",
  "message": "Access token required",
  "details": "Please provide a valid access token in the Authorization header"
}
```

**Status**: `403 Forbidden` - Not player's turn
```json
{
  "error": "Forbidden",
  "details": "Not your turn"
}
```

**Status**: `404 Not Found` - Player not in game
```json
{
  "error": "Not found",
  "details": "Player not found in game"
}
```

#### Example
```bash
curl -X POST "http://localhost:3001/api/players/borrow" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "gameId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    "amount": 10
  }'
```

#### Business Rules
1. Players can borrow up to 20 ECU per action
2. Debt incurred is 2x the borrowed amount (e.g., borrow 10, owe 20)
3. Debt is automatically repaid from delivery payoffs until fully cleared
4. There is no cap on total outstanding debt
5. Debt is visible to all players in the game

---

### 2. Deliver Load
**POST** `/deliver-load`

Delivers a load to fulfill a demand card. If the player has outstanding debt, the payoff is automatically applied to reduce the debt first.

#### Authentication
- **Required**: Yes (JWT Bearer token)

#### Authorization
- Player must exist in the specified game
- It must be the player's turn

#### Request Body
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gameId` | string | Yes | UUID of the game |
| `city` | string | Yes | City where load is delivered |
| `loadType` | string | Yes | Type of load being delivered |
| `cardId` | number | Yes | ID of the demand card being fulfilled |

```json
{
  "gameId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "city": "Berlin",
  "loadType": "Coal",
  "cardId": 42
}
```

#### Success Response
**Status**: `200 OK`

| Field | Type | Description |
|-------|------|-------------|
| `payment` | number | Gross payment amount from demand card |
| `repayment` | number | Amount applied to debt repayment (0 if no debt) |
| `updatedMoney` | number | New player money balance (after debt repayment) |
| `updatedDebtOwed` | number | Remaining debt owed |
| `updatedLoads` | array | Remaining loads on train |
| `newCard` | object | New demand card drawn to replace fulfilled card |

```json
{
  "payment": 15,
  "repayment": 10,
  "updatedMoney": 55,
  "updatedDebtOwed": 10,
  "updatedLoads": ["Iron"],
  "newCard": {
    "id": 87,
    "demands": [...]
  }
}
```

#### Debt Repayment Logic
When a player has outstanding debt (`debtOwed > 0`):
- `repayment = min(payment, debtOwed)`
- `netPaymentToPlayer = payment - repayment`
- Player's money increases by `netPaymentToPlayer`
- Player's debt decreases by `repayment`

**Example scenarios:**
| Debt Before | Payment | Repayment | Net to Player | Debt After |
|-------------|---------|-----------|---------------|------------|
| 0 | 15 | 0 | 15 | 0 |
| 20 | 15 | 15 | 0 | 5 |
| 10 | 15 | 10 | 5 | 0 |
| 15 | 15 | 15 | 0 | 0 |

---

## Data Models

### Player Object (Updated)
The Player object now includes debt information:

```typescript
interface Player {
  id: string;                    // UUID
  userId?: string;               // User ID for authentication
  name: string;                  // Player display name
  color: string;                 // Hex color code (e.g., "#FF0000")
  money: number;                 // Current money in ECU
  debtOwed: number;              // Amount remaining to repay (NEW)
  trainType: TrainType;          // Train type
  turnNumber: number;            // Current turn number
  trainState: TrainState;        // Train position and state
  hand: DemandCard[];            // Demand cards in hand
  cameraState?: CameraState;     // Per-player camera state
}
```

#### New Field: `debtOwed`
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `debtOwed` | number | 0 | Total amount the player must repay. This value is already doubled (when borrowing X, debtOwed increases by 2X). Debt is automatically repaid from delivery payoffs. |

### TrainType Enum
```typescript
type TrainType = 'Freight' | 'Fast Freight' | 'Heavy Freight' | 'Superfreight';
```

---

## Socket.IO Events

### State Patch Event
After a borrow action, a `state:patch` event is emitted to all clients in the game room with the updated player data.

```typescript
// Event name
'state:patch'

// Payload
{
  patch: {
    players: Player[]  // Updated player array with new money and debt values
  },
  serverSeq: number    // Server sequence number for ordering
}
```

---

## Changelog

### Version 1.1.0 (2026-01-18)
- Added `POST /borrow` endpoint for Mercy Rule borrowing
- Added `debtOwed` field to Player object
- Modified `POST /deliver-load` to include automatic debt repayment
- Added `repayment` and `updatedDebtOwed` fields to deliver-load response

### Version 1.0.0
- Initial player actions API

---

## Support
For issues or questions regarding the Player Actions API, please refer to the project documentation or create an issue in the repository.

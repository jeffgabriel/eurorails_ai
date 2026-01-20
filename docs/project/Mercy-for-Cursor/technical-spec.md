# Technical Specification: Mercy for Cursor (Borrowing Mechanic - Issue #159)

## Feature Summary
Implement borrowing mechanic allowing players to borrow 1-20 ECU from bank. Borrowed amount incurs 2x debt. Debt is automatically repaid from delivery payments until cleared.

## Technology Stack
- **Frontend**: React 18.2, Phaser 3.80, Zustand, react-hook-form, zod, Radix UI, sonner (toasts)
- **Backend**: Node.js/TypeScript, Express 4.22, pg 8.7, jsonwebtoken, Socket.IO
- **Database**: PostgreSQL with SQL migrations in `db/migrations/`, auto-applied on startup

## Data Model Changes

### Database Migration: `db/migrations/XXX_add_debt_to_players.sql`
```sql
ALTER TABLE players ADD COLUMN debt_owed INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN players.debt_owed IS 'Amount player owes to bank (in millions ECU). Repaid automatically from delivery payments.';
```

### Shared TypeScript Types (`src/shared/types/GameTypes.ts`)
```typescript
// Extend Player interface
export interface Player {
  // ... existing fields
  debtOwed: number; // NEW
}

// New action type
export interface TurnActionBorrow {
  kind: "borrow";
  amount: number;
  debtIncurred: number;
}

// Extend TurnActionDeliver
export interface TurnActionDeliver {
  // ... existing fields
  debtRepayment?: number; // NEW
}
```

## API Specification

### NEW: `POST /api/players/borrow`
**Auth**: JWT required  
**Request**: `{ gameId: string, amount: number }`  
**Validation**: amount is integer, 1 <= amount <= 20  
**Response 200**: `{ updatedMoney: number, debtIncurred: number, totalDebt: number }`  
**Errors**: 400 (validation), 401 (auth), 403 (not your turn), 404 (player not found), 500  
**Side Effects**:
- `players.money += amount`
- `players.debt_owed += amount * 2`
- Log action in `turn_actions`
- Socket.IO broadcast `state:patch`

### MODIFIED: `POST /api/players/deliver-load`
**Response 200** (extended):
```typescript
{
  payment: number;
  updatedMoney: number;
  updatedLoads: LoadType[];
  newCard: DemandCard;
  debtRepayment?: number;    // NEW: only if debt > 0
  remainingDebt?: number;     // NEW: only if debt > 0
}
```
**Modified Logic**:
```typescript
const repayment = Math.min(payment, currentDebt);
money += (payment - repayment);
debt_owed -= repayment;
```

## Backend Implementation

### `src/server/services/playerService.ts`

**New Method**:
```typescript
static async borrowForUser(gameId: string, userId: string, amount: number): 
  Promise<{ updatedMoney: number; debtIncurred: number; totalDebt: number }>
```
**Implementation Pattern**:
1. Begin transaction, lock player row `FOR UPDATE`
2. Validate: gameId, userId, amount (1-20, integer)
3. Validate turn: `activePlayerId === playerId`
4. Compute: `debtIncurred = amount * 2`, `updatedMoney = money + amount`, `totalDebt = debt_owed + debtIncurred`
5. Update: `UPDATE players SET money = $1, debt_owed = $2 WHERE id = $3`
6. Log: Insert `TurnActionBorrow` into `turn_actions`
7. Commit, return result

**Modified Method**: `deliverLoadForUser`
- Fetch `debt_owed` in SELECT query
- After computing payment:
  ```typescript
  const repayment = Math.min(payment, currentDebt);
  const updatedMoney = currentMoney + (payment - repayment);
  const updatedDebt = currentDebt - repayment;
  ```
- Update query includes `debt_owed = $4`
- Log includes `debtRepayment` if `repayment > 0`
- Return includes `debtRepayment` and `remainingDebt` if applicable

### `src/server/routes/playerRoutes.ts`

**New Route**:
```typescript
router.post('/borrow', authenticateToken, async (req, res) => {
  const { gameId, amount } = req.body;
  const userId = req.user?.id;
  
  // Validate inputs
  // Call PlayerService.borrowForUser()
  // Broadcast via emitStatePatch()
  // Handle errors: 400/401/403/404/500
});
```

## Frontend Implementation

### `src/client/services/PlayerStateService.ts`

**New Method**:
```typescript
async borrowMoney(gameId: string, amount: number): 
  Promise<{ updatedMoney: number; debtIncurred: number; totalDebt: number } | null> {
  const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/borrow`, {
    method: 'POST',
    body: JSON.stringify({ gameId, amount })
  });
  
  if (response.ok) {
    const result = await response.json();
    if (this.localPlayer) {
      this.localPlayer.money = result.updatedMoney;
      this.localPlayer.debtOwed = result.totalDebt;
    }
    return result;
  }
  return null;
}
```

**Modified**: `deliverLoad` response handling to include `debtRepayment` and `remainingDebt`

### `src/client/components/BorrowMoneyDialog.tsx` (NEW)

**Component**: React dialog using Radix UI primitives  
**Form**: react-hook-form + zod validation  
**Validation Schema**:
```typescript
const borrowSchema = z.object({
  amount: z.number().int().min(1).max(20)
});
```
**Features**:
- Amount input/slider (1-20)
- Preview text: "Borrowing X will add 2X to your debt"
- Confirm/Cancel buttons
- Loading state during API call
- Error toast on failure (using `sonner`)

### UI Updates

**Debt Indicator** (in UIManager or GameScene):
- Format: "Debt: ECU XM" (red text)
- Visible only when `debtOwed > 0` for local player
- Updated via `socketService.onPatch()`

**Borrow Money Button** (action menu):
- Enabled only on player's turn
- Opens BorrowMoneyDialog on click

**Delivery Notification** (modify existing):
- If debt > 0: "Delivered [Load] to [City]: Earned [X]M, Repaid [Y]M debt, Net: [Z]M"
- If debt = 0: Normal delivery message

### `src/client/scenes/GameScene.ts`

**Socket.IO State Sync**:
- Ensure `onPatch()` updates `gameState.players[i].debtOwed`
- No special handling needed (standard patch flow)

## Implementation Checklist

### Backend (Phase 1)
- [ ] Database Migration
  - [ ] Create `db/migrations/XXX_add_debt_to_players.sql`
  - [ ] Add `debt_owed INTEGER NOT NULL DEFAULT 0` to `players` table
  - [ ] Test migration locally

- [ ] PlayerService - Borrow Method
  - [ ] Implement `borrowForUser(gameId, userId, amount)`
  - [ ] Validate amount (1-20, integer)
  - [ ] Validate turn (activePlayerId === playerId)
  - [ ] Update `money` and `debt_owed` atomically
  - [ ] Log borrow action in `turn_actions`
  - [ ] Return `{ updatedMoney, debtIncurred, totalDebt }`

- [ ] PlayerService - Modify Deliver Method
  - [ ] Fetch `debt_owed` in SELECT query
  - [ ] Compute `repayment = min(payment, debt_owed)`
  - [ ] Update money: `money += (payment - repayment)`
  - [ ] Update debt: `debt_owed -= repayment`
  - [ ] Include `debtRepayment` in action log if `repayment > 0`
  - [ ] Return `debtRepayment` and `remainingDebt` if applicable

- [ ] API Route
  - [ ] Create `POST /api/players/borrow` in `playerRoutes.ts`
  - [ ] Add `authenticateToken` middleware
  - [ ] Validate request body (`gameId`, `amount`)
  - [ ] Call `PlayerService.borrowForUser()`
  - [ ] Broadcast via `emitStatePatch(gameId, { players: [updatedPlayer] })`
  - [ ] Handle errors (400, 401, 403, 404, 500)

- [ ] Unit Tests
  - [ ] Test `borrowForUser` success (amount 10 → money +10, debt +20)
  - [ ] Test `borrowForUser` validation (0, 21, 5.5 → errors)
  - [ ] Test `borrowForUser` not your turn → 403
  - [ ] Test `deliverLoadForUser` no debt → unchanged behavior
  - [ ] Test `deliverLoadForUser` debt < payment → full repayment
  - [ ] Test `deliverLoadForUser` debt > payment → partial repayment

- [ ] Integration Tests
  - [ ] Test `POST /api/players/borrow` endpoint (success, 400, 401, 403)
  - [ ] Test `POST /api/players/deliver-load` with debt scenarios

### Frontend (Phase 2)
- [ ] Update Shared Types
  - [ ] Add `debtOwed: number` to `Player` interface
  - [ ] Add `TurnActionBorrow` interface
  - [ ] Add `debtRepayment?: number` to `TurnActionDeliver`

- [ ] PlayerStateService
  - [ ] Implement `borrowMoney(gameId, amount)` method
  - [ ] Update `localPlayer.debtOwed` on success
  - [ ] Modify `deliverLoad()` to handle `debtRepayment`/`remainingDebt`

- [ ] BorrowMoneyDialog Component
  - [ ] Create `src/client/components/BorrowMoneyDialog.tsx`
  - [ ] Implement form with amount input (1-20)
  - [ ] Use react-hook-form + zod validation
  - [ ] Show preview: "Borrowing X will add 2X to your debt"
  - [ ] Call `PlayerStateService.borrowMoney()` on submit
  - [ ] Show loading state during API call
  - [ ] Display error toast on failure

- [ ] UI Updates
  - [ ] Add debt indicator to Player HUD
    - Format: "Debt: ECU XM" (red text)
    - Visible only when `debtOwed > 0`
  - [ ] Add "Borrow Money" button to action menu
    - Enabled only on player's turn
    - Opens BorrowMoneyDialog on click
  - [ ] Update delivery notification with payment breakdown when debt > 0

- [ ] Socket.IO State Sync
  - [ ] Ensure `socketService.onPatch()` updates `gameState.players[i].debtOwed`
  - [ ] Test debt display updates for all clients

- [ ] Accessibility
  - [ ] Add ARIA labels to borrow button and dialog
  - [ ] Ensure keyboard navigation (Tab, Enter, ESC)
  - [ ] Test with screen reader

### Testing (Phase 3)
- [ ] Manual Testing
  - [ ] Borrow flow (open dialog, select amount, confirm)
  - [ ] Debt display updates correctly
  - [ ] Delivery with no debt (unchanged)
  - [ ] Delivery with debt < payment (partial repayment)
  - [ ] Delivery with debt > payment (full repayment)
  - [ ] Borrowing on not player's turn (should fail)
  - [ ] Borrowing invalid amounts (0, 21, 5.5) (should fail)

- [ ] Multiplayer Testing
  - [ ] Player 1 borrows, Player 2 sees updated money
  - [ ] Player 1 delivers with debt, Player 2 sees updated money
  - [ ] Test Socket.IO synchronization

- [ ] E2E Tests (optional)
  - [ ] Write E2E test for complete borrow → repay flow

### Documentation (Phase 4)
- [ ] Add code comments explaining debt repayment logic
- [ ] Document design decision: debt visibility (private to local player)

## Key Design Decisions

1. **Debt Visibility**: Private (only local player sees their debt). Server broadcasts `debtOwed` but frontend only displays for local player.
2. **Borrowing Restrictions**: Lenient mode (allow multiple borrows, debt can accumulate). Each borrow capped at 20 ECU.
3. **Undo Support**: Yes, log borrow actions in `turn_actions` for undo functionality.
4. **Notification**: Toast notifications using `sonner` library.

## Testing Scenarios

**Borrow**:
- Borrow 10M → money +10M, debt +20M
- Borrow on not your turn → error 403
- Borrow invalid amounts (0, 21, 5.5) → error 400

**Delivery with Debt**:
- Debt 0, deliver 15M → money +15M, debt stays 0
- Debt 20M, deliver 15M → money +0M, debt becomes 5M
- Debt 10M, deliver 15M → money +5M, debt becomes 0M

## File Locations

**Backend**:
- `db/migrations/XXX_add_debt_to_players.sql` (NEW)
- `src/server/services/playerService.ts` (MODIFY: add `borrowForUser`, modify `deliverLoadForUser`)
- `src/server/routes/playerRoutes.ts` (MODIFY: add `/borrow` route)
- `src/server/services/__tests__/playerService.test.ts` (MODIFY: add tests)
- `src/server/routes/__tests__/playerRoutes.test.ts` (MODIFY: add tests)

**Frontend**:
- `src/shared/types/GameTypes.ts` (MODIFY: extend Player, add TurnActionBorrow)
- `src/client/services/PlayerStateService.ts` (MODIFY: add `borrowMoney`)
- `src/client/components/BorrowMoneyDialog.tsx` (NEW)
- `src/client/scenes/GameScene.ts` (MODIFY: add debt display, borrow button)
- `src/client/components/UIManager.ts` (MODIFY: integrate BorrowMoneyDialog)

## Timeline Estimate
- Backend: 1-2 days (migration, service methods, API route, tests)
- Frontend: 1-2 days (types, service, dialog component, UI updates)
- Testing: 1 day (manual, multiplayer, bug fixes)
- Documentation: 1 hour
- **Total**: 3-5 days




# Game Design Decisions

## Borrowing Mechanic (Mercy Rule - Issue #159)

### Overview
The borrowing mechanic implements the "Mercy Rule" from the Eurorails rulebook, providing players with a financial safety net when cash is too low to build, pay track fees, or recover from difficult situations.

**Rule Reference:** "A player may borrow up to ECU 20 million from the bank. The player must pay back double the borrowed amount from all delivery payoffs until fully repaid."

---

### Debt Visibility

**Decision:** Debt (`debt_owed`) is synced to all clients but primarily displayed only to the local player.

**Rationale:**
- The server broadcasts `debtOwed` for all players via Socket.IO state patches, making it technically public data.
- The frontend UI is designed to display the debt indicator exclusively in the local player's HUD/status bar.
- This design reduces visual clutter and focuses each player's attention on their immediate financial state.
- Other players can see the borrowing player's updated money balance, providing indirect visibility into financial health without explicitly showing debt amounts.

**Implementation Notes:**
- `debtOwed` is a standard field in the `Player` interface and is automatically synced via the spread operator in `GameScene.ts` socket patch handler.
- The debt indicator (red text) appears in `PlayerHandDisplay.ts` only when the local player's `debtOwed > 0`.

---

### Borrowing Restrictions

**Decision:** Lenient borrowing mode with per-transaction cap.

**Rationale:**
- Players can borrow multiple times, allowing debt to accumulate. There is **no limit on total outstanding debt**.
- Each individual borrow transaction is capped at **1-20 ECU million** (validated in backend).
- This provides flexibility for players to manage their finances while preventing excessively large single-transaction borrows.
- The lenient mode (vs. strict "only one loan at a time") better supports the spirit of the Mercy Rule: preventing soft-locks without overly restricting player agency.

**Implementation Notes:**
- Validation occurs in `playerService.ts:borrowForUser()`:
  ```typescript
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 20) {
    throw new Error("Invalid borrow amount. Must be an integer between 1 and 20.");
  }
  ```
- Borrowing is only allowed on the player's turn (enforced by checking `activePlayerId` in backend).

---

### Automatic Debt Repayment

**Decision:** Debt is automatically repaid from delivery payoffs before crediting the player's money.

**Rationale:**
- Per the Mercy Rule, repayment is automatic, not optional.
- Prioritizing debt repayment simplifies gameplay: players don't need to manually manage repayment.
- The repayment calculation is straightforward: `repayment = min(payment, debt_owed)`.
- This ensures debt is paid down as quickly as possible while still allowing players to earn net money from deliveries.

**Implementation Notes:**
- Debt repayment logic is in `playerService.ts:deliverLoadForUser()`:
  ```typescript
  const repayment = Math.min(payment, currentDebt);
  const netPayment = payment - repayment;
  const updatedMoney = currentMoney + netPayment;
  const updatedDebt = currentDebt - repayment;
  ```
- The delivery notification UI (`LoadDialogScene.ts`) displays repayment details: "Earned XM, Repaid YM debt, Net: ZM".

---

### Undo Support

**Decision:** Borrow actions are logged in `turn_actions` table for potential undo functionality.

**Rationale:**
- To support the existing "undo last action" feature in the game, every borrow action is explicitly logged.
- This ensures a historical record of financial transactions that can be reversed if the player undoes their turn.
- Consistency with other turn actions (move, deliver) that are already logged.

**Implementation Notes:**
- Borrow actions are recorded as `TurnActionBorrow` in `turn_actions` table:
  ```typescript
  const borrowAction: TurnActionBorrow = {
    kind: "borrow",
    amount,
    debtIncurred,
  };
  ```
- Delivery actions now include optional `debtRepayment` field in `TurnActionDeliver` for undo support.

---

### Technical Architecture Summary

**Database:**
- New column: `players.debt_owed INTEGER NOT NULL DEFAULT 0`
- Migration: `021_add_debt_to_players.sql`
- Constraint: `debt_owed >= 0` (CHECK constraint)

**Backend API:**
- New endpoint: `POST /api/players/borrow`
  - Validates turn, amount, and player existence
  - Atomically updates `money` and `debt_owed` in a transaction
  - Broadcasts updated player state via Socket.IO
- Modified endpoint: `POST /api/players/deliver-load`
  - Now handles automatic debt repayment
  - Returns `debtRepayment` and `remainingDebt` in response

**Frontend UI:**
- `BorrowMoneyDialogScene.ts`: Phaser scene for borrowing UI (amount selector, preview text, validation)
- `PlayerHandDisplay.ts`: Shows debt indicator (red text) and "Borrow Money" button (only on player's turn)
- `LoadDialogScene.ts`: Enhanced delivery notification to show debt repayment details
- `PlayerStateService.ts`: Client-side methods `borrowMoney()` and updated `deliverLoad()` for debt handling

**Real-time State Sync:**
- `debtOwed` is automatically synced via Socket.IO `state:patch` events in `GameScene.ts`
- All clients receive debt updates when any player borrows or repays debt

---

### Future Considerations

1. **Debt Limits:** Currently, no cap on total outstanding debt. Consider adding a global debt limit (e.g., 100 ECU) if gameplay balance requires it.
2. **Interest/Penalties:** The Mercy Rule specifies 2X repayment as written. No additional penalties are implemented.
3. **Bankruptcy:** If a player cannot pay track fees or build, they may borrow. If even borrowing doesn't help, consider implementing a "bankruptcy" or "restart" mechanic (already exists in Mercy Rules).
4. **AI Debt Strategy:** If AI players are added, they should be programmed to borrow strategically when needed to avoid soft-locks.

---

## Revision History

| Date       | Author    | Change                                      |
|------------|-----------|---------------------------------------------|
| 2026-01-19 | AI Agent  | Initial documentation for Mercy Rule (GH#159) |



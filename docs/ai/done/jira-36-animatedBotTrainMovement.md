# JIRA-36: Animated Bot Train Movement

## Problem

When a bot completes its turn, the train sprite teleports instantly to the final position. The player sees the pawn at city A, then it suddenly appears at city B with no visual indication of the route taken. This makes it impossible to follow bot strategy visually and breaks immersion.

## Current Flow

1. Bot turn executes on server (`TurnExecutor.handleMoveTrain`) — moves bot to final destination via `PlayerService.moveTrainForUser`
2. Server emits `game:patch` with updated player position
3. `GameScene.onPatch` detects position change for non-local player (line 377)
4. Calls `uiManager.updateTrainPosition(playerId, x, y, row, col, { persist: false })`
5. `TrainSpriteManager.createOrUpdateSprite` sets sprite position instantly — no tween, no intermediate steps

The movement path (array of `{ row, col }` mileposts) exists in `TurnPlanMoveTrain.path` and is available during execution, but is **not sent to the client**. The `bot:turn-complete` socket event has `movementData` but only includes `from`/`to` endpoints, not the full path.

## Solution

### 1. Send movement path in `bot:turn-complete`

Add `movementPath: { row: number; col: number }[]` to the `bot:turn-complete` payload. This is the full milepost-by-milepost path the bot's train traversed.

**Source data:** `TurnPlanMoveTrain.path` is already computed. Thread it through `ExecutionResult` → `BotTurnResult` → socket emission.

**File:** `src/server/services/ai/TurnExecutor.ts` — add `movementPath` to `ExecutionResult`
**File:** `src/server/services/ai/AIStrategyEngine.ts` — add `movementPath` to `BotTurnResult`, populate from execution results
**File:** `src/server/services/ai/BotTurnTrigger.ts` — include `movementPath` in `bot:turn-complete` emission

### 2. Listen for `bot:turn-complete` in GameScene

`GameScene` already listens for socket events via `socketService`. Add a listener for `bot:turn-complete` that, when `movementPath` is present, triggers an animated tween sequence instead of the instant position update.

**File:** `src/client/scenes/GameScene.ts`

```typescript
socketService.on('bot:turn-complete', (data: any) => {
  if (data.movementPath && data.movementPath.length > 1) {
    this.animateBotMovement(data.botPlayerId, data.movementPath);
  }
});
```

### 3. Animate train along path using Phaser tweens

Create a method that tweens the train sprite through each milepost in sequence.

**File:** `src/client/scenes/GameScene.ts` or new `src/client/components/BotTrainAnimator.ts`

```typescript
async animateBotMovement(
  playerId: string,
  path: { row: number; col: number }[]
): Promise<void> {
  // Convert grid coords to world pixel positions
  const worldPath = path.map(p => {
    const gp = this.mapRenderer.gridPoints[p.row]?.[p.col];
    return gp ? { x: gp.x, y: gp.y, row: p.row, col: p.col } : null;
  }).filter(Boolean);

  if (worldPath.length < 2) return;

  // Tween through each waypoint
  for (let i = 1; i < worldPath.length; i++) {
    const target = worldPath[i];
    await new Promise<void>(resolve => {
      // Update sprite position via tween
      this.scene.tweens.add({
        targets: spriteContainer,
        x: target.x,
        y: target.y,
        duration: MILEPOST_TWEEN_MS, // ~120-200ms per milepost
        ease: 'Linear',
        onComplete: () => resolve()
      });
    });
  }

  // Final position sync (authoritative)
  const final = worldPath[worldPath.length - 1];
  this.uiManager.updateTrainPosition(
    playerId, final.x, final.y, final.row, final.col,
    { persist: false }
  );
}
```

### 4. Suppress instant teleport during animation

The `game:patch` will still arrive with the final position. If an animation is in progress for that player, the patch handler should skip the instant `updateTrainPosition` call and let the animation finish.

```typescript
// In GameScene.onPatch, non-local player branch:
if (this.activeAnimations.has(updatedPlayer.id)) {
  // Animation in progress — skip instant position update
  // Animation will set final position when complete
  continue;
}
```

Track active animations in a `Set<string>` keyed by playerId.

### 5. Camera follow (optional enhancement)

During bot animation, optionally pan the camera to follow the train:
- If the bot train is off-screen, smoothly pan to its starting position before the animation begins
- Follow the train during movement with `camera.startFollow()` or manual pan
- This can be a follow-up enhancement; core requirement is just the path animation

## Timing

| Constant | Value | Notes |
|----------|-------|-------|
| `MILEPOST_TWEEN_MS` | 150ms | Per-milepost tween duration |
| Typical 9-milepost move | ~1.2s total | 9 mileposts × 150ms |
| Typical 12-milepost move | ~1.8s total | 12 mileposts × 150ms |

The `bot:turn-complete` already has a 1.5s delay before the next bot turn fires (`BotTurnTrigger` delay). Animation should fit within this window for 9-milepost moves. For 12-milepost moves, the delay may need a slight increase or the tween speed reduced.

## Multi-Action Turns

A bot turn often has multiple steps: `[MoveTrain, PickupLoad, MoveTrain, DeliverLoad, BuildTrack]`. The movement path sent should be the **concatenated path across all MoveTrain steps** in the plan, so the animation shows the full route traversed.

Alternatively, send an array of paths (one per MoveTrain step) and animate them in sequence with brief pauses between to indicate pickup/delivery events.

## Key Files

| File | Change |
|------|--------|
| `src/server/services/ai/TurnExecutor.ts` | Add `movementPath` to `ExecutionResult` |
| `src/server/services/ai/AIStrategyEngine.ts` | Thread `movementPath` into `BotTurnResult` |
| `src/server/services/ai/BotTurnTrigger.ts` | Include `movementPath` in `bot:turn-complete` |
| `src/client/scenes/GameScene.ts` | Listen for `bot:turn-complete`, animate path |
| `src/client/components/TrainSpriteManager.ts` | Expose sprite reference for tween targeting |
| `src/client/components/BotTrainAnimator.ts` | (optional) Extracted animation logic |

## Edge Cases

- **Ferry crossing in path**: Path contains a jump across water. Detect ferry edges (non-adjacent row/col) and either skip the tween for that segment or use a distinct visual (fade-out/fade-in)
- **No movement in turn**: `movementPath` is empty/undefined — no animation needed
- **Rapid bot turns**: If next bot turn fires before animation completes, either cancel the current animation (snap to final) or queue the next animation
- **Multiple bots**: Each bot should animate independently; concurrent animations are fine since bots take turns sequentially

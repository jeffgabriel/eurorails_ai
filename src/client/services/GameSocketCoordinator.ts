import { GameStateService, PatchSpriteUpdate } from './GameStateService';
import { PlayerStateService, RefreshSpriteUpdate } from './PlayerStateService';
import { LoadService } from './LoadService';
import { authenticatedFetch } from './authenticatedFetch';
import { config } from '../config/apiConfig';
import { socketService } from '../lobby/shared/socket';
import { useGameStore } from '../lobby/store/game.store';
import type { TrackDrawingManager } from '../components/TrackDrawingManager';

/**
 * Dependencies injected by GameScene when starting the coordinator. A single
 * typed object (rather than positional/boolean params) documents every seam
 * GameScene must wire up and rules out mixing up two same-typed arguments.
 */
export interface GameSocketCoordinatorDeps {
  gameId: string;
  gameStateService: GameStateService;
  playerStateService: PlayerStateService;
  loadService: LoadService;
  /**
   * Accessor rather than a direct reference: TrackDrawingManager is created
   * after registration begins, so handlers must read the current value
   * lazily instead of closing over a stale `undefined`.
   */
  getTrackManager: () => TrackDrawingManager | undefined;
  /** Resolve a grid row/col to world coordinates for sprite placement. */
  getMapGridPoint: (row: number, col: number) => { x: number; y: number } | undefined;
  isBotAnimating: (playerId: string) => boolean;
  onApplySpriteUpdates: (updates: RefreshSpriteUpdate[]) => void;
  onUIRefresh: () => void;
  onLaunchWinner: (winnerId: string, winnerName: string) => void;
  onTieExtended: (newThreshold: number) => void;
  onAutoRunStatus: (enabled: boolean) => void;
  onBotTurnComplete: (data: unknown) => void;
}

/**
 * Owns all game-specific Socket.IO wiring for a single GameScene instance:
 * the connect-or-poll transport decision, every game socket subscription,
 * and the debounced HTTP resync used to heal state after a reconnect or a
 * detected sequence gap. GameScene creates one instance per `create()` call
 * and pairs `start()` with `stop()` in `destroy()` — the instance owns its
 * `gameId` for its whole lifetime rather than having it threaded through
 * every method call.
 */
export class GameSocketCoordinator {
  private static readonly RESYNC_DEBOUNCE_MS = 250;

  private gameId = '';
  private unsubs: Array<() => void> = [];
  private resyncTimer?: number;
  private resyncInFlight = false;

  /**
   * Ensure a socket connection, join the game room, and register every
   * game-specific socket handler. Returns `false` (fail closed) when no
   * connection could be established — the caller is expected to fall back
   * to HTTP polling rather than silently proceeding with no realtime updates.
   */
  async start(deps: GameSocketCoordinatorDeps): Promise<boolean> {
    // Guard against re-entry: a stale start() (e.g. a scene re-created
    // without a paired stop()) must not leave duplicate subscriptions behind.
    this.stop();

    this.gameId = deps.gameId;

    const token = localStorage.getItem('eurorails.jwt') ?? '';
    const connected = await socketService.ensureConnected(token);
    if (!connected) {
      console.warn('[GameSocketCoordinator] Socket not connected; caller should fall back to polling.');
      return false;
    }

    socketService.join(this.gameId);
    this.registerHandlers(deps);
    return true;
  }

  /** Clear the resync timer and all stored subscriptions. Safe to call more than once. */
  stop(): void {
    if (this.resyncTimer !== undefined) {
      window.clearTimeout(this.resyncTimer);
      this.resyncTimer = undefined;
    }
    this.resyncInFlight = false;

    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch (error) {
        console.error('[GameSocketCoordinator] Error while unsubscribing socket listener:', error);
      }
    }
    this.unsubs = [];
  }

  private registerHandlers(deps: GameSocketCoordinatorDeps): void {
    // Registering onInit causes SocketService to start tracking serverSeq from
    // the 'state:init' payload (bug #4: GameScene previously never registered
    // this listener, so serverSeq was never seeded and onPatch's seq-gap
    // detection could never fire correctly for a fresh game session).
    socketService.onInit(() => {
      // SocketService seeds `serverSeq` internally before invoking this
      // callback — no further action needed here.
    });

    // NOTE: the server payload's field is `currentPlayerIndex`, which is not
    // part of socketService.onTurnChange's declared callback type (pre-existing
    // mismatch, not introduced here) — keep the `any` cast to match actual
    // runtime shape rather than the stale declared type.
    socketService.onTurnChange((data: any) => {
      const playerIndex = data?.currentPlayerIndex;
      if (playerIndex !== undefined && playerIndex !== deps.gameStateService.getGameState().currentPlayerIndex) {
        deps.gameStateService.updateCurrentPlayerIndex(playerIndex);
      }
    });

    // `patch` is typed `any` here because the wire payload is `Partial<FullGameState>`,
    // not the lobby `GameState` socketService.onPatch declares (pre-existing mismatch).
    socketService.onPatch((data: { patch: any; serverSeq: number }) => {
      const { spriteUpdates } = deps.gameStateService.applyServerPatch(data.patch);
      this.applySpriteUpdates(spriteUpdates, deps);
      deps.onUIRefresh();
    });

    socketService.onVictoryTriggered((data) => {
      if (data.gameId !== this.gameId) return;
      const gameState = deps.gameStateService.getGameState();
      gameState.victoryState = {
        triggered: true,
        triggerPlayerIndex: data.triggerPlayerIndex,
        victoryThreshold: data.victoryThreshold,
        finalTurnPlayerIndex: data.finalTurnPlayerIndex,
      };
      deps.onUIRefresh();
    });

    socketService.onGameOver((data) => {
      if (data.gameId !== this.gameId) return;
      deps.gameStateService.getGameState().status = 'completed';
      deps.onLaunchWinner(data.winnerId, data.winnerName);
    });

    socketService.onTieExtended((data) => {
      if (data.gameId !== this.gameId) return;
      const gameState = deps.gameStateService.getGameState();
      gameState.victoryState = {
        triggered: false,
        triggerPlayerIndex: -1,
        victoryThreshold: data.newThreshold,
        finalTurnPlayerIndex: -1,
      };
      deps.onTieExtended(data.newThreshold);
      deps.onUIRefresh();
    });

    socketService.onTrackUpdated(async (data) => {
      if (data.gameId !== this.gameId) return;
      const trackManager = deps.getTrackManager();
      if (!trackManager) return;
      try {
        await trackManager.loadExistingTracks();
        trackManager.drawAllTracks();
      } catch (error) {
        console.error('[GameSocketCoordinator] Error reloading tracks after update:', error);
      }
    });

    // Event card listeners write straight to the Zustand store; the store's
    // own connect() is not used from GameScene, so these must live here.
    socketService.onEventCardDrawn((payload) => {
      useGameStore.getState().showEventOverlay(payload);
    });
    socketService.onEventEffectExpired((payload) => {
      useGameStore.getState().removeActiveEffect(payload.cardId);
    });
    socketService.onActiveEffects((effects) => {
      useGameStore.getState().setActiveEffects(effects);
    });

    this.unsubs.push(
      socketService.onAutoRunStatus((data) => {
        deps.onAutoRunStatus(data.enabled);
      }),
    );

    // Single subscription fanning out bot:turn-complete payloads to the caller.
    this.unsubs.push(
      socketService.onAnyEvent((eventName: string, ...args: any[]) => {
        if (eventName !== 'bot:turn-complete') return;
        deps.onBotTurnComplete(args[0]);
      }),
    );

    this.unsubs.push(
      socketService.onReconnected(() => {
        this.scheduleSocketResync('reconnect', deps);
      }),
    );

    this.unsubs.push(
      socketService.onSeqGap(({ expected, received }) => {
        this.scheduleSocketResync(`seq-gap ${expected}->${received}`, deps);
      }),
    );
  }

  /**
   * Resolve a batch of sprite updates to world coordinates, skipping any
   * player whose train is mid-animation (an instant snap would fight the
   * animation). Shared by the onPatch handler (row/col only) and the resync
   * path (row/col/x/y already known) so GameScene has one apply path instead
   * of two near-duplicate ones.
   */
  private applySpriteUpdates(
    updates: Array<PatchSpriteUpdate | RefreshSpriteUpdate>,
    deps: GameSocketCoordinatorDeps,
  ): void {
    const resolved: RefreshSpriteUpdate[] = [];
    for (const update of updates) {
      if (deps.isBotAnimating(update.playerId)) continue;

      if ('x' in update && 'y' in update) {
        resolved.push(update);
        continue;
      }

      const gridPoint = deps.getMapGridPoint(update.row, update.col);
      if (!gridPoint) continue;
      resolved.push({ playerId: update.playerId, x: gridPoint.x, y: gridPoint.y, row: update.row, col: update.col });
    }

    if (resolved.length > 0) {
      deps.onApplySpriteUpdates(resolved);
    }
  }

  /**
   * Debounce a resync so a burst of reconnects/seq-gaps within the window
   * triggers exactly one HTTP resync (250ms, matching the pre-existing
   * GameScene behavior this replaces).
   */
  private scheduleSocketResync(reason: string, deps: GameSocketCoordinatorDeps): void {
    if (!this.gameId) return;
    if (this.resyncTimer !== undefined) {
      window.clearTimeout(this.resyncTimer);
    }
    this.resyncTimer = window.setTimeout(() => {
      void this.runResync(reason, deps);
    }, GameSocketCoordinator.RESYNC_DEBOUNCE_MS);
  }

  private async runResync(reason: string, deps: GameSocketCoordinatorDeps): Promise<void> {
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    try {
      console.warn(`[GameSocketCoordinator] Resyncing via HTTP (${reason})`);

      // bug #1: currentPlayerIndex was never healed on resync because the
      // player refresh below only fetches player rows, not game-level state.
      await this.healCurrentPlayerIndex(deps);

      const { spriteUpdates } = await deps.playerStateService.refreshPlayersFromServer(
        this.gameId,
        deps.gameStateService.getGameState(),
      );
      this.applySpriteUpdates(spriteUpdates, deps);

      const trackManager = deps.getTrackManager();
      if (trackManager) {
        await trackManager.loadExistingTracks();
        trackManager.drawAllTracks();
      }

      await deps.loadService.loadInitialState();
      deps.onUIRefresh();
    } catch (error) {
      console.error('[GameSocketCoordinator] Socket resync failed:', error);
    } finally {
      this.resyncInFlight = false;
    }
  }

  private async healCurrentPlayerIndex(deps: GameSocketCoordinatorDeps): Promise<void> {
    try {
      const response = await authenticatedFetch(`${config.apiBaseUrl}/api/game/${this.gameId}`);
      if (!response.ok) {
        console.warn(`[GameSocketCoordinator] Failed to heal currentPlayerIndex: HTTP ${response.status}`);
        return;
      }
      const serverState = await response.json();
      if (typeof serverState?.currentPlayerIndex === 'number') {
        deps.gameStateService.updateCurrentPlayerIndex(serverState.currentPlayerIndex);
      }
    } catch (error) {
      console.error('[GameSocketCoordinator] Error healing currentPlayerIndex:', error);
    }
  }
}

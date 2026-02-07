import { GameState, BorrowResult } from '../../shared/types/GameTypes';
import { PlayerStateService } from './PlayerStateService';
import { config } from '../config/apiConfig';
import { TrainType } from '../../shared/types/GameTypes';

/**
 * Event listener type for turn changes
 */
type TurnChangeListener = (currentPlayerIndex: number) => void;
type StateChangeListener = () => void;

/**
 * Manages shared game state that applies to all players
 * For per-player operations, use PlayerStateService instead
 */
export class GameStateService {
    private gameState: GameState;
    private localPlayerId: string | null = null;
    private playerStateService: PlayerStateService | null = null; // Reference to PlayerStateService for local player checks
    private turnChangeListeners: TurnChangeListener[] = [];
    private stateChangeListeners: StateChangeListener[] = [];
    private pollingInterval: number | null = null;
    
    constructor(gameState: GameState) {
        this.gameState = gameState;
    }
    
    /**
     * Set reference to PlayerStateService to enable local player checks
     */
    public setPlayerStateService(playerStateService: PlayerStateService): void {
        this.playerStateService = playerStateService;
    }
    
    /**
     * Get the local player ID
     */
    public getLocalPlayerId(): string | null {
        if (this.playerStateService) {
            return this.playerStateService.getLocalPlayerId();
        }
        return null; // Don't fallback to unused localPlayerId field - delegate to PlayerStateService
    }
    
    /**
     * Check if local player is the currently active player
     */
    public isLocalPlayerActive(): boolean {
        if (!this.playerStateService) {
            return false;
        }
        const localPlayerId = this.playerStateService.getLocalPlayerId();
        if (!localPlayerId) {
            return false;
        }
        const currentPlayer = this.getCurrentPlayer();
        return currentPlayer?.id === localPlayerId;
    }
    
    public getGameState(): GameState {
        return this.gameState;
    }
    
    public updateGameState(gameState: GameState): void {
        this.gameState = gameState;
    }
    
    /**
     * Move to the next player's turn
     * Server-authoritative: API call first, update local state only after success
     * Note: getCurrentPlayer() is about turn management (shared state), so it belongs in GameStateService.
     * PlayerStateService focuses on local player operations only.
     */
    public async nextPlayerTurn(): Promise<void> {
        // Calculate next player index (for API call only, not for local state)
        const nextPlayerIndex = (this.gameState.currentPlayerIndex + 1) % this.gameState.players.length;
        
        // Server-authoritative: Make API call first
        try {
            // Use authenticatedFetch for automatic token refresh
            const { authenticatedFetch } = await import('./authenticatedFetch');
            
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/updateCurrentPlayer`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    currentPlayerIndex: nextPlayerIndex
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update current player:', errorData);
                // Don't update local state on failure
                return;
            }

            // Only update local state after API succeeds.
            // Do NOT call notifyTurnChange here — the server emits a socket
            // turn:change event which is the single source of truth.  Calling
            // notifyTurnChange from the POST response adds a racing async
            // handleTurnChange call whose result is unpredictable when bots
            // advance the turn in rapid succession.
            const updatedState = await response.json();
            if (updatedState.currentPlayerIndex !== undefined) {
                this.gameState.currentPlayerIndex = updatedState.currentPlayerIndex;
            }
        } catch (error) {
            console.error('Error updating current player:', error);
            // Don't update local state on error
        }
    }
    
    /**
     * Start polling for turn changes from the server
     * This is a fallback if Socket.IO is not available
     */
    public startPollingForTurnChanges(intervalMs: number = 2000): void {
        if (this.pollingInterval) {
            this.stopPollingForTurnChanges();
        }
        
        this.pollingInterval = window.setInterval(async () => {
            try {
                // Check if gameState exists before polling
                if (!this.gameState || !this.gameState.id) {
                    return;
                }
                
                // Include auth headers in polling requests
                const token = localStorage.getItem('eurorails.jwt');
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                };
                if (token) {
                    headers.Authorization = `Bearer ${token}`;
                }
                
                const response = await fetch(`${config.apiBaseUrl}/api/game/${this.gameState.id}`, {
                    headers
                });
                if (!response.ok) {
                    // Stop polling on authentication errors
                    if (response.status === 401 || response.status === 403) {
                        this.stopPollingForTurnChanges();
                    }
                    return;
                }
                
                const gameState = await response.json();
                if (gameState.currentPlayerIndex !== undefined && 
                    gameState.currentPlayerIndex !== this.gameState.currentPlayerIndex) {
                    // Turn has changed
                    this.gameState.currentPlayerIndex = gameState.currentPlayerIndex;
                    this.notifyTurnChange(gameState.currentPlayerIndex);
                }
            } catch (error) {
                console.error('Error polling for turn changes:', error);
            }
        }, intervalMs);
    }
    
    /**
     * Stop polling for turn changes
     */
    public stopPollingForTurnChanges(): void {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }
    
    /**
     * Add a listener for turn changes
     */
    public onTurnChange(listener: TurnChangeListener): void {
        this.turnChangeListeners.push(listener);
    }
    
    /**
     * Remove a turn change listener
     */
    public offTurnChange(listener: TurnChangeListener): void {
        this.turnChangeListeners = this.turnChangeListeners.filter(l => l !== listener);
    }
    
    /**
     * Notify all listeners of a turn change
     */
    private notifyTurnChange(currentPlayerIndex: number): void {
        this.turnChangeListeners.forEach(listener => {
            try {
                listener(currentPlayerIndex);
            } catch (error) {
                console.error('Error in turn change listener:', error);
            }
        });
    }

    /**
     * Notify listeners that local game state has changed (e.g. after a server-authoritative
     * action updates a player but does not necessarily trigger a turn change).
     *
     * IMPORTANT: This is intended for local actions that already merged server response data
     * into `this.gameState` (purchaseTrainType/discardHand/restart, etc.). Socket-driven state
     * patches should continue to refresh UI through GameScene's socket handler.
     */
    private notifyStateChange(): void {
        this.stateChangeListeners.forEach(listener => {
            try {
                listener();
            } catch (error) {
                console.error('Error in state change listener:', error);
            }
        });
    }

    public onStateChange(listener: StateChangeListener): void {
        this.stateChangeListeners.push(listener);
    }

    public offStateChange(listener: StateChangeListener): void {
        this.stateChangeListeners = this.stateChangeListeners.filter(l => l !== listener);
    }
    
    /**
     * Update current player index (called when receiving turn change event)
     */
    public updateCurrentPlayerIndex(newIndex: number): void {
        if (newIndex !== this.gameState.currentPlayerIndex) {
            this.gameState.currentPlayerIndex = newIndex;
            this.notifyTurnChange(newIndex);
        }
    }
    
    public async loadInitialGameState(gameId: string): Promise<GameState | null> {
        try {
            // Get auth token from localStorage to include in request
            const token = localStorage.getItem('eurorails.jwt');
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            
            // First fetch the game state with auth headers
            const gameResponse = await fetch(`${config.apiBaseUrl}/api/game/${gameId}`, {
                headers
            });
            if (!gameResponse.ok) {
                console.error('Failed to load game state:', await gameResponse.text());
                return null;
            }
            
            const gameState = await gameResponse.json();
            this.gameState = gameState;
            return gameState;
        } catch (error) {
            console.error('Error loading game state:', error);
            return null;
        }
    }
    
    public getCurrentPlayer() {
        if (!this.gameState.players || this.gameState.players.length === 0) {
            return null;
        }
        return this.gameState.players[this.gameState.currentPlayerIndex];
    }
    
    public getGameId(): string {
        return this.gameState.id;
    }
    
    public getCurrentPlayerIndex(): number {
        return this.gameState.currentPlayerIndex;
    }
    
    public getPlayers() {
        return this.gameState.players;
    }

    /**
     * Purchase a train upgrade or crossgrade for the local player's active turn.
     * Server-authoritative: endpoint validates money, legality, and per-turn track spend.
     */
    public async purchaseTrainType(
        kind: 'upgrade' | 'crossgrade',
        targetTrainType: TrainType
    ): Promise<{ ok: boolean; errorMessage?: string }> {
        try {
            const { authenticatedFetch } = await import('./authenticatedFetch');
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/upgrade-train`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    kind,
                    targetTrainType
                })
            });

            if (!response.ok) {
                const errorData: any = await response.json().catch(() => ({}));
                // Keep console noise low: return a user-facing message to the caller.
                const details = (typeof errorData?.details === 'string' && errorData.details.trim().length > 0)
                    ? errorData.details
                    : (typeof errorData?.error === 'string' ? errorData.error : 'Purchase failed');
                return { ok: false, errorMessage: details };
            }

            const data = await response.json();
            const updatedPlayer = data?.player;
            if (!updatedPlayer?.id) {
                return { ok: false, errorMessage: 'Purchase failed' };
            }

            // Merge into local game state
            const idx = this.gameState.players.findIndex(p => p.id === updatedPlayer.id);
            if (idx >= 0) {
                // IMPORTANT: mutate in-place so any existing references (e.g. PlayerStateService.localPlayer)
                // stay valid. Replacing the object can cause later updates (like money-only updates)
                // to send stale trainType back to the server.
                const existing: any = this.gameState.players[idx];
                Object.assign(existing, updatedPlayer);
                if (updatedPlayer.trainState) {
                    if (existing.trainState) {
                        Object.assign(existing.trainState, updatedPlayer.trainState);
                    } else {
                        existing.trainState = updatedPlayer.trainState;
                    }
                }
            }

            this.notifyStateChange();
            return { ok: true };
        } catch (error) {
            // Avoid noisy console logging; callers can show a toast.
            return { ok: false, errorMessage: 'Purchase failed' };
        }
    }

    /**
     * Discard the local player's entire demand hand and redraw 3 cards, consuming the turn.
     * Server-authoritative: endpoint validates start-of-turn constraints and advances the turn.
     */
    public async discardHandAndEndTurn(): Promise<{ ok: boolean; errorMessage?: string; nextPlayerName?: string }> {
        try {
            const { authenticatedFetch } = await import('./authenticatedFetch');
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/discard-hand`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: this.gameState.id
                })
            });

            if (!response.ok) {
                const errorData: any = await response.json().catch(() => ({}));
                const details = (typeof errorData?.details === 'string' && errorData.details.trim().length > 0)
                    ? errorData.details
                    : (typeof errorData?.error === 'string' ? errorData.error : 'Discard failed');
                return { ok: false, errorMessage: details };
            }

            const data = await response.json();
            const updatedPlayer = data?.player;
            const nextIndex = data?.currentPlayerIndex;
            const nextPlayerName = typeof data?.nextPlayerName === 'string' ? data.nextPlayerName : undefined;

            if (!updatedPlayer?.id) {
                return { ok: false, errorMessage: 'Discard failed' };
            }

            // Merge updated player (including hand) into local game state (in-place mutation).
            const idx = this.gameState.players.findIndex(p => p.id === updatedPlayer.id);
            if (idx >= 0) {
                const existing: any = this.gameState.players[idx];
                Object.assign(existing, updatedPlayer);
                if (updatedPlayer.trainState) {
                    if (existing.trainState) {
                        Object.assign(existing.trainState, updatedPlayer.trainState);
                    } else {
                        existing.trainState = updatedPlayer.trainState;
                    }
                }
                // Ensure hand is replaced for local player so they can review it even after turn ends.
                if (Array.isArray(updatedPlayer.hand)) {
                    existing.hand = updatedPlayer.hand;
                }
            }

            // Immediately update currentPlayerIndex from the server response (even if socket is delayed).
            if (typeof nextIndex === 'number' && Number.isFinite(nextIndex)) {
                this.updateCurrentPlayerIndex(nextIndex);
            }

            // Even though the turn changes, notify so UI can refresh immediately if sockets are down.
            this.notifyStateChange();
            return { ok: true, nextPlayerName };
        } catch (error) {
            return { ok: false, errorMessage: 'Discard failed' };
        }
    }

    /**
     * Restart (reset) the local player's state to a clean baseline.
     * Server-authoritative: validates it's your turn + start-of-turn constraints, resets money/train/loads/position/hand, clears track.
     * Does NOT end the turn.
     */
    public async restartPlayer(): Promise<{ ok: boolean; errorMessage?: string }> {
        try {
            const { authenticatedFetch } = await import('./authenticatedFetch');
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/restart`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: this.gameState.id
                })
            });

            if (!response.ok) {
                const errorData: any = await response.json().catch(() => ({}));
                const details = (typeof errorData?.details === 'string' && errorData.details.trim().length > 0)
                    ? errorData.details
                    : (typeof errorData?.error === 'string' ? errorData.error : 'Restart failed');
                return { ok: false, errorMessage: details };
            }

            const data = await response.json();
            const updatedPlayer = data?.player;
            if (!updatedPlayer?.id) {
                return { ok: false, errorMessage: 'Restart failed' };
            }

            // Merge updated player (including hand) into local game state (in-place mutation).
            const idx = this.gameState.players.findIndex(p => p.id === updatedPlayer.id);
            if (idx >= 0) {
                const existing: any = this.gameState.players[idx];
                Object.assign(existing, updatedPlayer);
                if (updatedPlayer.trainState) {
                    if (existing.trainState) {
                        Object.assign(existing.trainState, updatedPlayer.trainState);
                    } else {
                        existing.trainState = updatedPlayer.trainState;
                    }
                }
                if (Array.isArray(updatedPlayer.hand)) {
                    existing.hand = updatedPlayer.hand;
                }
            }

            this.notifyStateChange();
            return { ok: true };
        } catch (error) {
            return { ok: false, errorMessage: 'Restart failed' };
        }
    }

    /**
     * Borrow money from the bank (Mercy Rule).
     * Delegates to PlayerStateService for per-player operations.
     * Server-authoritative: validates it's your turn, amount constraints.
     * Returns borrowed amount, debt incurred, and updated balances.
     */
    public async borrowMoney(gameId: string, amount: number): Promise<BorrowResult | null> {
        if (!this.playerStateService) {
            console.error('Cannot borrow money: PlayerStateService not available');
            return null;
        }

        try {
            const result = await this.playerStateService.borrowMoney(gameId, amount);
            this.notifyStateChange();
            return result;
        } catch (error) {
            console.error('Borrow failed:', error);
            return null;
        }
    }
}
import { GameState } from '../../shared/types/GameTypes';
import { PlayerStateService } from './PlayerStateService';
import { config } from '../config/apiConfig';
import { TrainType } from '../../shared/types/GameTypes';

/**
 * Event listener type for turn changes
 */
type TurnChangeListener = (currentPlayerIndex: number) => void;

/**
 * Manages shared game state that applies to all players
 * For per-player operations, use PlayerStateService instead
 */
export class GameStateService {
    private gameState: GameState;
    private localPlayerId: string | null = null;
    private playerStateService: PlayerStateService | null = null; // Reference to PlayerStateService for local player checks
    private turnChangeListeners: TurnChangeListener[] = [];
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

            // Only update local state after API succeeds
            const updatedState = await response.json();
            if (updatedState.currentPlayerIndex !== undefined) {
                this.gameState.currentPlayerIndex = updatedState.currentPlayerIndex;
                // Notify listeners of turn change
                this.notifyTurnChange(this.gameState.currentPlayerIndex);
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
    ): Promise<boolean> {
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
                const errorData = await response.json().catch(() => ({}));
                console.error('Failed to purchase train type:', errorData);
                return false;
            }

            const data = await response.json();
            const updatedPlayer = data?.player;
            if (!updatedPlayer?.id) {
                return false;
            }

            // Merge into local game state
            const idx = this.gameState.players.findIndex(p => p.id === updatedPlayer.id);
            if (idx >= 0) {
                this.gameState.players[idx] = {
                    ...this.gameState.players[idx],
                    ...updatedPlayer
                };
            }

            return true;
        } catch (error) {
            console.error('Error purchasing train type:', error);
            return false;
        }
    }
}
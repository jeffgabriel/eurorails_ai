import { GameState } from '../../shared/types/GameTypes';
import { PlayerStateService } from './PlayerStateService';

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
    
    public async nextPlayerTurn(): Promise<void> {
        // Move to the next player
        this.gameState.currentPlayerIndex = (this.gameState.currentPlayerIndex + 1) % this.gameState.players.length;
        
        try {
            // Update the current player in the database
            const response = await fetch('/api/players/updateCurrentPlayer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    currentPlayerIndex: this.gameState.currentPlayerIndex
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update current player:', errorData);
            } else {
                // Update local state with response
                const updatedState = await response.json();
                if (updatedState.currentPlayerIndex !== undefined) {
                    this.gameState.currentPlayerIndex = updatedState.currentPlayerIndex;
                    // Notify listeners of turn change
                    this.notifyTurnChange(this.gameState.currentPlayerIndex);
                }
            }
        } catch (error) {
            console.error('Error updating current player:', error);
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
                
                const response = await fetch(`/api/game/${this.gameState.id}`, {
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
            const gameResponse = await fetch(`/api/game/${gameId}`, {
                headers
            });
            if (!gameResponse.ok) {
                console.error('Failed to load game state:', await gameResponse.text());
                return null;
            }
            
            const gameState = await gameResponse.json();
            this.gameState = gameState;
            
            // Sanitize logging to avoid exposing sensitive player information
            console.log('Loaded game state with', gameState.players?.length || 0, 'players');
            
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
}
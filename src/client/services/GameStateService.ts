import { GameState } from '../../shared/types/GameTypes';

/**
 * Manages shared game state that applies to all players
 * For per-player operations, use PlayerStateService instead
 */
export class GameStateService {
    private gameState: GameState;
    private localPlayerId: string | null = null;
    
    constructor(gameState: GameState) {
        this.gameState = gameState;
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
            }
        } catch (error) {
            console.error('Error updating current player:', error);
        }
    }
    
    public async loadInitialGameState(gameId: string): Promise<GameState | null> {
        try {
            // First fetch the game state
            const gameResponse = await fetch(`/api/game/${gameId}`);
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
}
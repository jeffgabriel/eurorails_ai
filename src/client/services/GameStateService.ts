import { GameState } from '../../shared/types/GameTypes';

export class GameStateService {
    private gameState: GameState;
    
    constructor(gameState: GameState) {
        this.gameState = gameState;
    }
    
    public getGameState(): GameState {
        return this.gameState;
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
    
    public async updatePlayerMoney(playerId: string, newMoney: number): Promise<boolean> {
        // Find player in the local state and update money
        const playerIndex = this.gameState.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) {
            console.error('Player not found in game state:', playerId);
            return false;
        }
        
        // Update local state
        this.gameState.players[playerIndex].money = newMoney;
        
        try {
            // Update the player in the database
            const player = this.gameState.players[playerIndex];
            const response = await fetch('/api/players/update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    player: player
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update player money:', errorData);
                return false;
            }
            
            return true;
        } catch (error) {
            console.error('Error updating player money:', error);
            return false;
        }
    }

    public async updatePlayerPosition(
        playerId: string, 
        x: number, 
        y: number, 
        row: number, 
        col: number
    ): Promise<boolean> {
        console.log('GameStateService.updatePlayerPosition - Initial state:', {
            playerCount: this.gameState.players.length,
            players: this.gameState.players.map(p => ({ id: p.id, name: p.name }))
        });

        // Find player in the local state and update position
        const playerIndex = this.gameState.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) {
            console.error('Player not found in game state:', playerId);
            return false;
        }
        
        // Update local state
        // Make sure trainState exists before attempting to set position
        if (!this.gameState.players[playerIndex].trainState) {
            this.gameState.players[playerIndex].trainState = {
                position: null,  // Type is Point | null
                remainingMovement: 0,
                movementHistory: []
            };
        }
        
        // Now safely set the position
        this.gameState.players[playerIndex].trainState.position = { x, y, row, col };
        
        console.log('GameStateService.updatePlayerPosition - After local update:', {
            playerCount: this.gameState.players.length,
            players: this.gameState.players.map(p => ({ id: p.id, name: p.name }))
        });
        
        try {
            // Update the player in the database
            const player = this.gameState.players[playerIndex];
            const response = await fetch('/api/players/update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    player: player
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update player position:', errorData);
                return false;
            }
            
            return true;
        } catch (error) {
            console.error('Error updating player position:', error);
            return false;
        }
    }
}
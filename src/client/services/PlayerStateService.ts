import { Player, TrainState } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';

/**
 * Manages per-player state and operations for the local player
 * Separates player-specific concerns from shared game state
 */
export class PlayerStateService {
    private localPlayerId: string | null = null;
    private localPlayer: Player | null = null;

    /**
     * Identifies and stores the local player based on authenticated user
     * @param players - Array of all players in the game
     * @returns true if local player was successfully identified
     */
    public initializeLocalPlayer(players: Player[]): boolean {
        try {
            // Get user from localStorage (same pattern as SetupScene.ts)
            const userJson = localStorage.getItem('eurorails.user');
            if (!userJson) {
                console.warn('No user found in localStorage - cannot identify local player');
                return false;
            }

            const user = JSON.parse(userJson);
            const userId = user.id;

            if (!userId) {
                console.warn('User object missing id field');
                return false;
            }

            // Find matching player in gameState by userId
            const matchingPlayer = players.find(
                player => player.userId === userId
            );

            if (!matchingPlayer) {
                console.warn(`No player found for userId: ${userId}. Player may not be in this game.`);
                // Could be spectator mode - handle gracefully
                return false;
            }

            this.localPlayerId = matchingPlayer.id;
            this.localPlayer = matchingPlayer;
            console.log(`Local player identified: ${matchingPlayer.name} (${this.localPlayerId})`);
            return true;
        } catch (error) {
            console.error('Error identifying local player:', error);
            return false;
        }
    }

    /**
     * Update local player reference when game state changes
     */
    public updateLocalPlayer(players: Player[]): void {
        if (!this.localPlayerId) {
            this.initializeLocalPlayer(players);
            return;
        }

        // Find the local player in the updated players array
        this.localPlayer = players.find(p => p.id === this.localPlayerId) || null;
        if (!this.localPlayer) {
            console.warn('Local player not found in updated player list');
        }
    }

    /**
     * Get the local player's ID
     */
    public getLocalPlayerId(): string | null {
        return this.localPlayerId;
    }

    /**
     * Get the local player object
     */
    public getLocalPlayer(): Player | null {
        return this.localPlayer;
    }

    /**
     * Check if local player is the currently active player
     */
    public isCurrentPlayer(currentPlayerIndex: number, players: Player[]): boolean {
        if (!this.localPlayerId) {
            return false;
        }
        const currentPlayer = players[currentPlayerIndex];
        return currentPlayer?.id === this.localPlayerId;
    }

    /**
     * Check if a given player ID is the local player
     */
    public isLocalPlayer(playerId: string): boolean {
        return this.localPlayerId === playerId;
    }

    /**
     * Update local player's money
     */
    public async updatePlayerMoney(newMoney: number, gameId: string): Promise<boolean> {
        if (!this.localPlayer) {
            console.error('Cannot update money: no local player');
            return false;
        }

        try {
            const response = await fetch('/api/players/update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: gameId,
                    player: {
                        ...this.localPlayer,
                        money: newMoney
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update player money:', errorData);
                return false;
            }

            // Update local state
            this.localPlayer.money = newMoney;
            return true;
        } catch (error) {
            console.error('Error updating player money:', error);
            return false;
        }
    }

    /**
     * Update local player's position
     */
    public async updatePlayerPosition(
        x: number,
        y: number,
        row: number,
        col: number,
        gameId: string
    ): Promise<boolean> {
        if (!this.localPlayer) {
            console.error('Cannot update position: no local player');
            return false;
        }

        // Ensure trainState exists
        if (!this.localPlayer.trainState) {
            this.localPlayer.trainState = {
                position: null,
                remainingMovement: 0,
                movementHistory: [],
                loads: []
            };
        }

        this.localPlayer.trainState.position = { x, y, row, col };

        try {
            const response = await fetch('/api/players/update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: gameId,
                    player: this.localPlayer
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

    /**
     * Update local player's loads
     */
    public async updatePlayerLoads(loads: LoadType[], gameId: string): Promise<boolean> {
        if (!this.localPlayer) {
            console.error('Cannot update loads: no local player');
            return false;
        }

        // Initialize trainState if it doesn't exist
        if (!this.localPlayer.trainState) {
            this.localPlayer.trainState = {
                position: null,
                remainingMovement: 0,
                movementHistory: [],
                loads: []
            };
        }

        this.localPlayer.trainState.loads = loads;

        try {
            const response = await fetch('/api/players/update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: gameId,
                    player: this.localPlayer
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update player loads:', errorData);
                return false;
            }

            return true;
        } catch (error) {
            console.error('Error updating player loads:', error);
            return false;
        }
    }

    /**
     * Fulfill a demand card for the local player
     */
    public async fulfillDemandCard(
        city: string,
        loadType: LoadType,
        cardId: number,
        gameId: string
    ): Promise<boolean> {
        if (!this.localPlayer || !this.localPlayerId) {
            console.error('Cannot fulfill demand: no local player');
            return false;
        }

        try {
            const response = await fetch('/api/players/fulfill-demand', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: gameId,
                    playerId: this.localPlayerId,
                    city: city,
                    loadType: loadType,
                    cardId: cardId
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to fulfill demand:', errorData);
                return false;
            }

            const result = await response.json();

            if (!result.newCard) {
                console.error('No new card provided from server');
                return false;
            }

            // Remove the fulfilled card from player's hand and add new card
            this.localPlayer.hand = this.localPlayer.hand.filter(card => card.id !== cardId);
            this.localPlayer.hand.push(result.newCard);

            return true;
        } catch (error) {
            console.error('Error fulfilling demand:', error);
            return false;
        }
    }

    /**
     * Update the local player's train state
     */
    public updateTrainState(trainState: Partial<TrainState>): void {
        if (!this.localPlayer) {
            console.error('Cannot update train state: no local player');
            return;
        }

        if (!this.localPlayer.trainState) {
            this.localPlayer.trainState = {
                position: null,
                remainingMovement: 0,
                movementHistory: [],
                loads: []
            };
        }

        this.localPlayer.trainState = {
            ...this.localPlayer.trainState,
            ...trainState
        };
    }
}


import { Player, TrainState } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import { DemandCard } from '../../shared/types/DemandCard';
import { config } from '../config/apiConfig';
import { authenticatedFetch } from './authenticatedFetch';

/**
 * Manages per-player state and operations for the local player
 * Separates player-specific concerns from shared game state
 */
export class PlayerStateService {
    private localPlayerId: string | null = null;
    private localPlayer: Player | null = null;

    /**
     * Create a copy of a Player object but omit trainState.position.
     * This prevents accidental position overwrites when updating unrelated fields.
     */
    private createPlayerWithoutPosition(player: Player): Player {
        const playerCopy: Player = { ...player };
        if (playerCopy.trainState) {
            const trainStateWithoutPosition = {
                ...playerCopy.trainState
            };
            delete (trainStateWithoutPosition as any).position;
            playerCopy.trainState = trainStateWithoutPosition as any;
        }
        return playerCopy;
    }

    /**
     * Identifies and stores the local player based on authenticated user
     * @param players - Array of all players in the game
     * @returns true if local player was successfully identified
     */
    public initializeLocalPlayer(players: Player[]): boolean {
        try {
            // Get user from localStorage (same pattern as SetupScene.ts)
            const userJson = localStorage.getItem('eurorails.user');
            const userId = userJson ? (JSON.parse(userJson)?.id) : null;

            let matchingPlayer: Player | undefined;

            // First try: Match by userId if we have one
            if (userId) {
                matchingPlayer = players.find(player => player.userId === userId);
                
                if (matchingPlayer) {
                    this.localPlayerId = matchingPlayer.id;
                    this.localPlayer = matchingPlayer;
                    return true;
                }
            }

            // Second try: Fallback for single-player or legacy games without userId
            // Use the first player as local player
            if (players.length === 1) {
                matchingPlayer = players[0];
                this.localPlayerId = matchingPlayer.id;
                this.localPlayer = matchingPlayer;
                return true;
            }

            // Could not identify local player
            if (userId) {
                console.warn(`No player found for userId: ${userId}. Multiple players in game.`);
            } else {
                console.warn('No userId found and multiple players in game. Cannot identify local player.');
            }
            return false;
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
     * Server-authoritative: API call first, update local state only after success
     */
    public async updatePlayerMoney(newMoney: number, gameId: string): Promise<boolean> {
        if (!this.localPlayer) {
            console.error('Cannot update money: no local player');
            return false;
        }

        // Server-authoritative: Make API call first
        // IMPORTANT: Don't send position when updating money - position is managed separately
        try {
            const playerWithoutPosition = this.createPlayerWithoutPosition(this.localPlayer);
            
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/update`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: gameId,
                    player: {
                        ...playerWithoutPosition,
                        money: newMoney
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update player money:', errorData);
                return false;
            }

            // Only update local state after API succeeds
            this.localPlayer.money = newMoney;
            return true;
        } catch (error) {
            console.error('Error updating player money:', error);
            return false;
        }
    }

    /**
     * Update local player's position
     * Server-authoritative: API call first, update local state only after success
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

        // Ensure trainState exists for the API call
        if (!this.localPlayer.trainState) {
            this.localPlayer.trainState = {
                position: null,
                remainingMovement: 0,
                movementHistory: [],
                loads: []
            };
        }

        // Server-authoritative: Make API call first
        try {
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/update`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: gameId,
                    player: {
                        ...this.localPlayer,
                        trainState: {
                            ...this.localPlayer.trainState,
                            position: { x, y, row, col }
                        }
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update player position:', errorData);
                return false;
            }

            // Only update local state after API succeeds
            this.localPlayer.trainState.position = { x, y, row, col };
            return true;
        } catch (error) {
            console.error('Error updating player position:', error);
            return false;
        }
    }

    /**
     * Update local player's loads
     * Server-authoritative: API call first, update local state only after success
     */
    public async updatePlayerLoads(loads: LoadType[], gameId: string): Promise<boolean> {
        if (!this.localPlayer) {
            console.error('Cannot update loads: no local player');
            return false;
        }

        // Initialize trainState if it doesn't exist (for API call)
        if (!this.localPlayer.trainState) {
            this.localPlayer.trainState = {
                position: null,
                remainingMovement: 0,
                movementHistory: [],
                loads: []
            };
        }

        // Server-authoritative: Make API call first
        // IMPORTANT: Don't send position when updating loads - position is managed separately
        // Sending position here can cause the train to jump backward if the position in
        // this.localPlayer is outdated (from server, not current local position)
        // We create a player object without position to avoid overwriting it
        try {
            const playerWithoutPosition = this.createPlayerWithoutPosition(this.localPlayer);
            const trainStateWithoutPosition = {
                ...(playerWithoutPosition.trainState as any),
                loads: loads
            };
            
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/update`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: gameId,
                    player: {
                        ...playerWithoutPosition,
                        trainState: trainStateWithoutPosition
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update player loads:', errorData);
                return false;
            }

            // Only update local state after API succeeds
            this.localPlayer.trainState.loads = loads;
            return true;
        } catch (error) {
            console.error('Error updating player loads:', error);
            return false;
        }
    }

    /**
     * Update local player's turn number (per-player turns taken).
     * Server-authoritative: API call first, update local state only after success.
     *
     * IMPORTANT: Don't send trainState.position here; position is managed separately.
     */
    public async updatePlayerTurnNumber(newTurnNumber: number, gameId: string): Promise<boolean> {
        if (!this.localPlayer) {
            console.error('Cannot update turn number: no local player');
            return false;
        }

        try {
            const playerWithoutPosition = this.createPlayerWithoutPosition(this.localPlayer);

            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/update`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: gameId,
                    player: {
                        ...playerWithoutPosition,
                        turnNumber: newTurnNumber
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update player turn number:', errorData);
                return false;
            }

            this.localPlayer.turnNumber = newTurnNumber;
            return true;
        } catch (error) {
            console.error('Error updating player turn number:', error);
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
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/fulfill-demand`, {
                method: 'POST',
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
     * Deliver a load:
     * - Server-authoritative: compute payment + validate demand server-side
     * - Updates local state only after success
     */
    public async deliverLoad(
        city: string,
        loadType: LoadType,
        cardId: number,
        gameId: string
    ): Promise<boolean> {
        if (!this.localPlayer || !this.localPlayerId) {
            console.error('Cannot deliver load: no local player');
            return false;
        }

        try {
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/deliver-load`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: gameId,
                    city: city,
                    loadType: loadType,
                    cardId: cardId
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to deliver load:', errorData);
                return false;
            }

            const result: { payment: number; newCard: DemandCard } = await response.json();
            if (!result?.newCard || typeof result.payment !== 'number') {
                console.error('Invalid deliver-load response from server');
                return false;
            }

            // Update loads (remove one instance)
            if (!this.localPlayer.trainState) {
                this.localPlayer.trainState = {
                    position: null,
                    remainingMovement: 0,
                    movementHistory: [],
                    loads: []
                };
            }
            const currentLoads = this.localPlayer.trainState.loads || [];
            const loadIndex = currentLoads.indexOf(loadType);
            const updatedLoads = [...currentLoads];
            if (loadIndex !== -1) {
                updatedLoads.splice(loadIndex, 1);
            }
            this.localPlayer.trainState.loads = updatedLoads;

            // Update money
            this.localPlayer.money = (this.localPlayer.money || 0) + result.payment;

            // Replace demand card in hand
            this.localPlayer.hand = (this.localPlayer.hand || []).filter(card => card.id !== cardId);
            this.localPlayer.hand.push(result.newCard);

            return true;
        } catch (error) {
            console.error('Error delivering load:', error);
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


import 'phaser';
import { FullGameState } from '../../shared/types/GameTypes';
import { IdService } from '../../shared/services/IdService';
import { DemandDeckService } from '../../shared/services/DemandDeckService';
import { DemandCard } from '../../shared/types/DemandCard';
import { config } from '../config/apiConfig';
import { authenticatedFetch } from '../services/authenticatedFetch';
export class SetupScene extends Phaser.Scene {
    private gameState: FullGameState;
    private errorText?: Phaser.GameObjects.Text;
    private demandDeckService: DemandDeckService;
    private pendingInitErrorMessage: string | null = null;

    private navigateToRoute(path: string, options?: { replace?: boolean }) {
        try {
            if (options?.replace) {
                window.history.replaceState({}, '', path);
            } else {
                window.history.pushState({}, '', path);
            }
            // BrowserRouter listens to popstate; force React Router to notice.
            window.dispatchEvent(new PopStateEvent('popstate'));
        } catch (e) {
            // Fallback to full navigation if history API is unavailable
            window.location.href = path;
        }
    }

    constructor() {
        super({ 
            key: 'SetupScene'
        });
        this.demandDeckService = new DemandDeckService();
        // Initialize with default state
        this.gameState = {
            id: IdService.generateGameId(),
            players: [],
            currentPlayerIndex: 0,
            status: 'setup',
            maxPlayers: 6        
        };
        
    }

    init(data: { gameState?: FullGameState; gameId?: string }) {
        // Prefer explicit init param; fall back to URL (important on refresh)
        const effectiveGameId = data.gameId ?? this.getGameIdFromUrl();

        if (!effectiveGameId) {
            // Never hard-redirect on missing init data; show a friendly error instead.
            this.pendingInitErrorMessage = 'Missing game id. Please return to the lobby and re-join the game.';
            console.warn('[SetupScene] Missing gameId in init and URL; cannot load game.');
            return;
        }

        this.pendingInitErrorMessage = null;
        this.loadSpecificGame(effectiveGameId);
    }

    private getGameIdFromUrl(): string | null {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const gameIdFromParams = urlParams.get('gameId');
            if (gameIdFromParams) return gameIdFromParams;

            const pathParts = window.location.pathname.split('/');
            const gameIndex = pathParts.indexOf('game');
            if (gameIndex !== -1 && pathParts[gameIndex + 1]) {
                return pathParts[gameIndex + 1];
            }
        } catch {
            // ignore
        }
        return null;
    }

    private async loadSpecificGame(gameId: string) {
        try {
            // For /game/:id, always load authoritative state via authenticated game endpoint.
            // This avoids lobby-only endpoints and fixes first-load flakiness.
            console.info('[SetupScene] Loading game from /api/game/:id', {
                gameId,
                hasToken: Boolean(localStorage.getItem('eurorails.jwt')),
                path: window.location.pathname,
            });

            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/game/${gameId}`, {
                method: 'GET',
            });

            if (response.status === 410) {
                // Completed/abandoned (server hides which). Show a friendly message.
                this.showGameCompletionMessage('completed');
                return;
            }

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`Failed to fetch game state (${response.status}) ${text ? `- ${text}` : ''}`);
            }

            const gameState = await response.json();
            this.gameState = gameState;

            // If the game is still in setup, send the user back to the lobby setup UI.
            if (this.gameState.status === 'setup') {
                this.navigateToRoute(`/lobby/game/${gameId}`);
                return;
            }

            // Start the actual game scenes for active/initialBuild.
            this.scene.start('GameScene', { gameState: this.gameState });
            return;
            
        } catch (error) {
            console.error('Error loading specific game:', error);
            // Show error message to user
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            this.showErrorMessage(`Failed to load game: ${errorMessage}`);
        }
        
        // If we can't load the specific game, error handling already occurred
    }

    private setupExistingPlayers() {
        
        // Add a full-screen white background rectangle to ensure complete coverage
        this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2,
            this.scale.width,
            this.scale.height,
            0xffffff
        ).setOrigin(0.5);

        // Add title
        this.add.text(this.scale.width / 2, 50, 'Game Setup', {
            color: '#000000',
            fontSize: '32px'
        }).setOrigin(0.5);

        // Add instructions
        this.add.text(this.scale.width / 2, 100, 'Players in this game:', {
            color: '#000000',
            fontSize: '18px',
            align: 'center'
        }).setOrigin(0.5);

        // Display existing players
        this.displayExistingPlayers();

        // Add start game button if we have enough players
        if (this.gameState.players.length >= 2) {
            this.addStartGameButton();
        } else if (this.gameState.players.length === 0) {
            this.add.text(this.scale.width / 2, 300, 'No players have joined yet. Waiting for players to join...', {
                color: '#666666',
                fontSize: '16px',
                align: 'center'
            }).setOrigin(0.5);
        } else {
            this.add.text(this.scale.width / 2, 300, `Waiting for more players... (${this.gameState.players.length}/2 minimum)`, {
                color: '#666666',
                fontSize: '16px',
                align: 'center'
            }).setOrigin(0.5);
        }
    }

    private displayExistingPlayers() {
        const startY = 150;
        const playerSpacing = 40;
        
        if (this.gameState.players.length === 0) {
            this.add.text(this.scale.width / 2, startY, 'No players yet', {
                color: '#999999',
                fontSize: '16px',
                align: 'center'
            }).setOrigin(0.5);
            return;
        }
        
        this.gameState.players.forEach((player, index) => {
            const y = startY + (index * playerSpacing);
            
            // Player color indicator
            const colorRect = this.add.rectangle(100, y, 20, 20, this.hexToNumber(player.color));
            colorRect.setStrokeStyle(2, 0x000000);
            
            // Player name
            this.add.text(140, y, player.name, {
                color: '#000000',
                fontSize: '16px'
            }).setOrigin(0, 0.5);
        });
    }

    private addStartGameButton() {
        const button = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height - 100,
            200,
            50,
            0x4CAF50
        );
        
        button.setStrokeStyle(2, 0x000000);
        button.setInteractive();
        
        this.add.text(this.scale.width / 2, this.scale.height - 100, 'Start Game', {
            color: '#000000',
            fontSize: '18px'
        }).setOrigin(0.5);
        
        button.on('pointerdown', () => {
            this.startGame();
        });
    }

    private hexToNumber(hex: string): number {
        return parseInt(hex.replace('#', ''), 16);
    }


    private showGameInProgressMessage() {
        // Add a full-screen white background rectangle
        this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2,
            this.scale.width,
            this.scale.height,
            0xffffff
        ).setOrigin(0.5);

        // Add title
        this.add.text(this.scale.width / 2, 50, 'Game In Progress', {
            color: '#000000',
            fontSize: '32px'
        }).setOrigin(0.5);

        // Add message
        this.add.text(this.scale.width / 2, this.scale.height / 2, 'This game is already in progress.\nYou cannot join an active game.', {
            color: '#666666',
            fontSize: '18px',
            align: 'center',
            wordWrap: { width: this.scale.width - 40 }
        }).setOrigin(0.5);

        // Add back button
        const backButton = this.add.rectangle(this.scale.width / 2, this.scale.height - 100, 200, 50, 0x4CAF50);
        backButton.setStrokeStyle(2, 0x000000);
        backButton.setInteractive();
        this.add.text(this.scale.width / 2, this.scale.height - 100, 'Back to Lobby', {
            color: '#000000',
            fontSize: '18px'
        }).setOrigin(0.5);
        
        backButton.on('pointerdown', () => {
            window.location.href = '/lobby';
        });
    }

    private showGameCompletionMessage(gameStatus: string) {
        // Add a full-screen white background rectangle
        this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2,
            this.scale.width,
            this.scale.height,
            0xffffff
        ).setOrigin(0.5);

        // Add title based on status
        const title = gameStatus === 'completed' ? 'Game Completed' : 'Game Ended';
        this.add.text(this.scale.width / 2, 50, title, {
            color: '#000000',
            fontSize: '32px'
        }).setOrigin(0.5);

        // Add message based on status
        const message = gameStatus === 'completed' 
            ? 'This game has been completed.\nAll players have finished playing.'
            : 'This game has been ended.\nOne or more players have left the game.';
        
        this.add.text(this.scale.width / 2, this.scale.height / 2, message, {
            color: '#666666',
            fontSize: '18px',
            align: 'center',
            wordWrap: { width: this.scale.width - 40 }
        }).setOrigin(0.5);

        // Add back to lobby button
        const backButton = this.add.rectangle(this.scale.width / 2, this.scale.height - 100, 200, 50, 0x4CAF50);
        backButton.setStrokeStyle(2, 0x000000);
        backButton.setInteractive();
        this.add.text(this.scale.width / 2, this.scale.height - 100, 'Back to Lobby', {
            color: '#000000',
            fontSize: '18px'
        }).setOrigin(0.5);
        
        backButton.on('pointerdown', () => {
            window.location.href = '/lobby';
        });
    }

    private showErrorMessage(message: string) {
        // Clear any existing error text
        if (this.errorText) {
            this.errorText.destroy();
        }
        
        // Add a full-screen white background rectangle
        this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2,
            this.scale.width,
            this.scale.height,
            0xffffff
        ).setOrigin(0.5);

        // Add title
        this.add.text(this.scale.width / 2, 50, 'Game Setup', {
            color: '#000000',
            fontSize: '32px'
        }).setOrigin(0.5);

        // Add error message
        this.errorText = this.add.text(this.scale.width / 2, this.scale.height / 2, message, {
            color: '#ff0000',
            fontSize: '18px',
            align: 'center',
            wordWrap: { width: this.scale.width - 40 }
        }).setOrigin(0.5);

        // Add back button
        const backButton = this.add.rectangle(this.scale.width / 2, this.scale.height - 100, 200, 50, 0x4CAF50);
        backButton.setStrokeStyle(2, 0x000000);
        backButton.setInteractive();
        this.add.text(this.scale.width / 2, this.scale.height - 100, 'Back to Lobby', {
            color: '#000000',
            fontSize: '18px'
        }).setOrigin(0.5);
        
        backButton.on('pointerdown', () => {
            window.location.href = '/lobby';
        });
    }

    private async startGame() {
        // Update game status to active
        try {
            // Get user ID from localStorage (same way as lobby store does)
            const userJson = localStorage.getItem('eurorails.user');
            let userId = '';
            if (userJson) {
                try {
                    const user = JSON.parse(userJson);
                    userId = user.id;
                } catch (error) {
                    console.warn('Failed to parse user from localStorage:', error);
                }
            }
            
            const response = await fetch(`${config.apiBaseUrl}/api/lobby/games/${this.gameState.id}/start`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-user-id': userId,
                },
                body: JSON.stringify({
                    creatorUserId: userId
                })
            });

            if (response.ok) {
                // Update local game state to active
                this.gameState.status = 'active';
                // Start the game scene
                this.scene.start('GameScene', { gameState: this.gameState });
            } else {
                console.error('Failed to start game:', await response.json());
            }
        } catch (error) {
            console.error('Error starting game:', error);
        }
    }


    preload() {
        // Set background color
        this.cameras.main.setBackgroundColor('#ffffff');
    }

    async create() {
        // Add a full-screen white background rectangle to ensure complete coverage
        this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2,
            this.scale.width,
            this.scale.height,
            0xffffff
        ).setOrigin(0.5);

        if (this.pendingInitErrorMessage) {
            this.showErrorMessage(this.pendingInitErrorMessage);
            return;
        }
        // loadSpecificGame (started from init) renders the scene once the game loads.
    }

    private async getPlayerHand(): Promise<DemandCard[]> {
        // Draw 3 cards for each player
        let cards: DemandCard[] = [];
        for (let i = 0; i < 3; i++) {
            const card = await this.demandDeckService.drawCard();
            if (card) {
                cards.push(card);
            } else {
                throw new Error('Not enough demand cards in deck');
            }
        }
        return cards;
    }

} 
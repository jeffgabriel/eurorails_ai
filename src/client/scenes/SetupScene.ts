import 'phaser';
import { Player, PlayerColor, GameState, INITIAL_PLAYER_MONEY, TrainType } from '../../shared/types/GameTypes';
import { IdService } from '../../shared/services/IdService';
import { DemandDeckService } from '../../shared/services/DemandDeckService';
import { DemandCard } from '../../shared/types/DemandCard';
import { config } from '../config/apiConfig';
import { authenticatedFetch } from '../services/authenticatedFetch';
export class SetupScene extends Phaser.Scene {
    private gameState: GameState;
    private nameInput?: HTMLInputElement;
    private colorButtons: Phaser.GameObjects.Rectangle[] = [];
    private selectedColor?: PlayerColor;
    private errorText?: Phaser.GameObjects.Text;
    private playerList?: Phaser.GameObjects.Text;
    private demandDeckService: DemandDeckService;
    private isLobbyGame: boolean = false;
    private pendingInitErrorMessage: string | null = null;

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

    init(data: { gameState?: GameState; gameId?: string }) {
        // Prefer explicit init param; fall back to URL (important on refresh)
        const effectiveGameId = data.gameId ?? this.getGameIdFromUrl();

        if (!effectiveGameId) {
            // Never hard-redirect on missing init data; show a friendly error instead.
            this.isLobbyGame = true;
            this.pendingInitErrorMessage = 'Missing game id. Please return to the lobby and re-join the game.';
            console.warn('[SetupScene] Missing gameId in init and URL; cannot load game.');
            return;
        }

        this.isLobbyGame = true;
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
                window.location.href = `/lobby/game/${gameId}`;
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

        // Add new game button
        const newGameButton = this.add.rectangle(this.scale.width / 2, this.scale.height - 170, 200, 50, 0x2196F3);
        newGameButton.setStrokeStyle(2, 0x000000);
        newGameButton.setInteractive();
        this.add.text(this.scale.width / 2, this.scale.height - 170, 'New Game', {
            color: '#ffffff',
            fontSize: '18px'
        }).setOrigin(0.5);
        
        newGameButton.on('pointerdown', () => {
            // Start a new game by clearing the current game state and resetting lobby status
            this.gameState = {
                id: IdService.generateGameId(),
                players: [],
                currentPlayerIndex: 0,
                status: 'setup',
                maxPlayers: 6        
            };
            // Reset lobby game status to allow proper setup flow
            this.isLobbyGame = false;
            this.create();
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

        // Only proceed with the old setup logic if we're not loading from the lobby
        if (!this.isLobbyGame) {
            // This is the old standalone setup flow - not used when loading from lobby
            this.setupStandaloneGame();
        }
        // If we're loading from lobby, the loadSpecificGame method will handle the setup
    }

    private async setupStandaloneGame() {
        // Check for active game first
        try {
            const response = await fetch(`${config.apiBaseUrl}/api/players/game/active`);
            if (response.ok) {
                const activeGame = await response.json();
                // Start game scene with active game
                this.scene.start('GameScene', { gameState: activeGame });
                return;
            }
        } catch (error) {
            console.error('Error checking for active game:', error);
        }

        // No active game found, create a new one
        const gameId = IdService.generateGameId();
        this.gameState.id = gameId;
        
        try {
            const response = await fetch(`${config.apiBaseUrl}/api/players/game/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: gameId
                })
            });

            if (!response.ok) {
                console.error('Failed to create game:', await response.json());
                return;
            }
        } catch (error) {
            console.error('Error creating game:', error);
            return;
        }

        // Continue with scene setup
        // Add title
        this.add.text(this.scale.width / 2, 50, 'Player Setup', {
            color: '#000000',
            fontSize: '32px'
        }).setOrigin(0.5);

        // Add instructions
        this.add.text(this.scale.width / 2, 100, 'Enter player name and select color\n(2-6 players required)', {
            color: '#000000',
            fontSize: '18px',
            align: 'center'
        }).setOrigin(0.5);

        // Create name input
        const inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.placeholder = 'Enter player name';
        inputElement.style.width = '200px';
        inputElement.style.padding = '8px';
        inputElement.style.fontSize = '16px';
        inputElement.style.textAlign = 'center';
        
        const inputContainer = document.createElement('div');
        inputContainer.style.position = 'relative';
        inputContainer.appendChild(inputElement);

        const domElement = this.add.dom(this.scale.width / 2, 200, inputContainer);
        domElement.setOrigin(0.5);
        this.nameInput = inputElement;

        // Create color selection
        const colors = Object.entries(PlayerColor);
        const spacing = 60;
        const totalWidth = colors.length * spacing;
        const startX = (this.scale.width - totalWidth) / 2 + spacing / 2;

        colors.forEach(([name, color], index) => {
            const x = startX + (index * spacing);
            const colorButton = this.add.rectangle(x, 300, 40, 40, parseInt(color.replace('#', '0x')));
            
            // Add border
            const border = this.add.rectangle(x, 300, 44, 44, 0x000000);
            border.setDepth(0);
            
            colorButton.setInteractive({ useHandCursor: true })
                .setDepth(1);

            colorButton.on('pointerdown', () => {
                this.selectedColor = color as PlayerColor;
                this.colorButtons.forEach((btn, i) => {
                    const isSelected = btn === colorButton;
                    btn.setStrokeStyle(isSelected ? 4 : 0, 0x000000);
                });
            });

            this.colorButtons.push(colorButton);

            // Add color name below
            this.add.text(x, 350, name, {
                color: '#000000',
                fontSize: '12px'
            }).setOrigin(0.5);
        });

        // Add player button
        const addButton = this.add.rectangle(this.scale.width / 2, 400, 200, 40, 0x00aa00);
        const addButtonText = this.add.text(this.scale.width / 2, 400, 'Add Player', {
            color: '#ffffff',
            fontSize: '18px'
        }).setOrigin(0.5);

        addButton.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.addPlayer())
            .on('pointerover', () => addButton.setFillStyle(0x008800))
            .on('pointerout', () => addButton.setFillStyle(0x00aa00));

        // Start game button
        const startButton = this.add.rectangle(this.scale.width / 2, 500, 200, 40, 0x0055aa);
        const startButtonText = this.add.text(this.scale.width / 2, 500, 'Start Game', {
            color: '#ffffff',
            fontSize: '18px'
        }).setOrigin(0.5);

        startButton.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.startGame())
            .on('pointerover', () => startButton.setFillStyle(0x004488))
            .on('pointerout', () => startButton.setFillStyle(0x0055aa));

        // Error text
        this.errorText = this.add.text(this.scale.width / 2, 450, '', {
            color: '#ff0000',
            fontSize: '16px'
        }).setOrigin(0.5);

        // Player list
        this.playerList = this.add.text(this.scale.width / 2 + 200, 200, 'Current Players:', {
            color: '#000000',
            fontSize: '16px'
        });

        this.updatePlayerList();
    }

    private async addPlayer() {
        if (!this.nameInput || !this.selectedColor) {
            this.showError('Please enter a name and select a color');
            return;
        }

        const name = this.nameInput.value.trim();
        if (!name) {
            this.showError('Please enter a valid name');
            return;
        }

        // Check if name is already taken
        if (this.gameState.players.some(p => p.name === name)) {
            this.showError('This name is already taken');
            return;
        }

        // Check if color is already taken
        if (this.gameState.players.some(p => p.color === this.selectedColor)) {
            this.showError('This color is already taken');
            return;
        }

        // Check max players
        if (this.gameState.players.length >= this.gameState.maxPlayers) {
            this.showError('Maximum number of players reached');
            return;
        }

        try {
            // Create new player on the server
            const response = await fetch(`${config.apiBaseUrl}/api/players/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    player: {
                        name,
                        color: this.selectedColor,
                        money: INITIAL_PLAYER_MONEY,
                        trainType: TrainType.Freight,  // Default train type
                        turnNumber: 1,
                        trainState: {
                            position: {x: 0, y: 0, row: 0, col: 0},
                            movementHistory: [],
                            remainingMovement: 9
                        },
                        hand: []  // Server will draw cards - don't send client-drawn cards
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.details || errorData.error || 'Failed to create player');
            }

            // Get the created player with server-generated ID
            const newPlayer = await response.json();
            this.gameState.players.push(newPlayer);
            // Update the train movement which isn't stored in the database.
            newPlayer.trainType == TrainType.FastFreight || newPlayer.trainType == TrainType.Superfreight ? newPlayer.trainState.remainingMovement = 12 : newPlayer.trainState.remainingMovement = 9;
            this.updatePlayerList();

            // Reset input
            this.nameInput.value = '';
            this.selectedColor = undefined;
            this.colorButtons.forEach(btn => btn.setStrokeStyle());
            this.showError('');
        } catch (error) {
            console.error('Error creating player:', error);
            this.showError(error instanceof Error ? error.message : 'Failed to create player');
        }
    }

    private updatePlayerList() {
        if (this.playerList) {
            let text = 'Current Players:\n\n';
            this.gameState.players.forEach(player => {
                text += `${player.name} (${Object.keys(PlayerColor).find(key => 
                    PlayerColor[key as keyof typeof PlayerColor] === player.color)})\n`;
            });
            this.playerList.setText(text);
        }
    }

    private showError(message: string) {
        if (this.errorText) {
            this.errorText.setText(message);
        }
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
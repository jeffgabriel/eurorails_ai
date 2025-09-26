import 'phaser';
import { Player, PlayerColor, GameState, INITIAL_PLAYER_MONEY } from '../../shared/types/GameTypes';
import { IdService } from '../../shared/services/IdService';
import { DemandDeckService } from '../../shared/services/DemandDeckService';
import { DemandCard } from '../../shared/types/DemandCard';
export class SetupScene extends Phaser.Scene {
    private gameState: GameState;
    private nameInput?: HTMLInputElement;
    private colorButtons: Phaser.GameObjects.Rectangle[] = [];
    private selectedColor?: PlayerColor;
    private errorText?: Phaser.GameObjects.Text;
    private playerList?: Phaser.GameObjects.Text;
    private demandDeckService: DemandDeckService;
    private isLobbyGame: boolean = false;

    constructor() {
        super({ 
            key: 'SetupScene',
            active: true
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
        console.log('SetupScene init called with data:', data);
        // If we have a specific gameId, try to load that game
        if (data.gameId) {
            console.log('Loading specific game with ID:', data.gameId);
            this.isLobbyGame = true;
            this.loadSpecificGame(data.gameId);
        } else {
            console.log('No gameId provided, fetching active game');
            this.isLobbyGame = false;
            // Always try to fetch the active game from the backend
            this.fetchAndSetActiveGame();
        }
    }

    private async loadSpecificGame(gameId: string) {
        try {
            // First, fetch the game data
            const gameResponse = await fetch(`/api/lobby/games/${gameId}`);
            if (!gameResponse.ok) {
                throw new Error(`Failed to fetch game: ${gameResponse.status}`);
            }
            
            const gameData = await gameResponse.json();
            
            // Validate API response structure
            if (!gameData || typeof gameData !== 'object') {
                throw new Error('Invalid game data response format');
            }
            
            const game = gameData.data; // The API returns { success: true, data: game }
            
            // Validate game data structure
            if (!game || typeof game !== 'object') {
                throw new Error('Invalid game data structure');
            }
            
            if (!game.id || !game.joinCode || !game.status) {
                throw new Error('Missing required game properties (id, joinCode, status)');
            }
            
            console.log('Raw game data from API:', game);
            console.log('Game created at:', game.createdAt);
            console.log('Game lobby status:', game.status);
            console.log('Game status:', game.gameStatus);

            // Then, fetch the players for this game
            const playersResponse = await fetch(`/api/lobby/games/${gameId}/players`);
            if (!playersResponse.ok) {
                throw new Error(`Failed to fetch players: ${playersResponse.status}`);
            }

            const playersData = await playersResponse.json();
            
            // Validate players response structure
            if (!playersData || typeof playersData !== 'object') {
                throw new Error('Invalid players data response format');
            }
            
            const lobbyPlayers = playersData.data; // The API returns { success: true, data: players }
            
            // Validate players data structure
            if (!Array.isArray(lobbyPlayers)) {
                throw new Error('Players data must be an array');
            }

            console.log('Game has', lobbyPlayers.length, 'players');
            console.log('lobbyPlayers:', lobbyPlayers);
            
            // Convert lobby players to game players format
            const gamePlayers: Player[] = lobbyPlayers.map((lobbyPlayer: any) => {
                // Validate individual player data
                if (!lobbyPlayer || typeof lobbyPlayer !== 'object') {
                    throw new Error('Invalid player data structure');
                }
                
                if (!lobbyPlayer.id || !lobbyPlayer.name || !lobbyPlayer.color) {
                    throw new Error('Missing required player properties (id, name, color)');
                }
                
                return {
                    id: lobbyPlayer.id,
                    name: lobbyPlayer.name,
                    color: lobbyPlayer.color,
                    money: INITIAL_PLAYER_MONEY, // Use the constant from GameTypes
                    trainType: 'freight',
                    turnNumber: 0,
                    trainState: {
                    position: null,
                    remainingMovement: 0,
                    movementHistory: [],
                    loads: []
                },
                hand: [] // Will be populated by demand deck service
                };
            });
            
            // Convert lobby game data to our game state format
            // Use gameStatus (actual game state) instead of status (lobby status)
            // Treat null gameStatus as 'setup'
            const effectiveGameStatus = game.gameStatus || 'setup';
            console.log('Effective game status:', effectiveGameStatus);

            this.gameState = {
                id: game.id,
                players: gamePlayers,
                currentPlayerIndex: 0,
                status: effectiveGameStatus === 'setup' ? 'setup' : 'active',
                maxPlayers: game.maxPlayers || 6
            };
            console.log('Updated gameState:', this.gameState);

            // If game is in setup status (or null, which we treat as setup), show the setup screen
            if (effectiveGameStatus === 'setup') {
                console.log('Game is in setup status, checking player count:', this.gameState.players.length);
                if (this.gameState.players.length > 0) {
                    console.log('Showing setup screen with', this.gameState.players.length, 'players');
                    this.setupExistingPlayers();
                } else {
                    console.log('Game in setup but no players yet');
                    this.setupExistingPlayers(); // This will show the waiting message
                }
                return;
            }
            
            // If game is in initialBuild or active status, transition to game scene
            if (game.gameStatus === 'initialBuild' || game.gameStatus === 'active') {
                console.log('Game is in', game.gameStatus, 'status, transitioning to game scene');
                this.scene.start('GameScene', { gameState: this.gameState });
                return;
            }
            
        } catch (error) {
            console.error('Error loading specific game:', error);
            // Show error message to user
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            this.showErrorMessage(`Failed to load game: ${errorMessage}`);
        }
        
        // If we can't load the specific game, error handling already occurred
    }

    private setupExistingPlayers() {
        console.log('DEBUG: setupExistingPlayers called with', this.gameState.players.length, 'players');
        console.log('DEBUG: this.gameState:', this.gameState);
        
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
            console.log('Adding start game button - game has', this.gameState.players.length, 'players');
            this.addStartGameButton();
        } else if (this.gameState.players.length === 0) {
            console.log('No players yet, showing waiting message');
            this.add.text(this.scale.width / 2, 300, 'No players have joined yet. Waiting for players to join...', {
                color: '#666666',
                fontSize: '16px',
                align: 'center'
            }).setOrigin(0.5);
        } else {
            console.log('Not enough players yet, showing waiting message');
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
        console.log('addStartGameButton called');
        
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
            console.log('Start Game button clicked!');
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
        console.log('startGame called for game', this.gameState.id);
        
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
            
            const response = await fetch(`/api/lobby/games/${this.gameState.id}/start`, {
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
                console.log('Game started successfully, updating local game state to active');
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

    private async fetchAndSetActiveGame() {
        try {
            const response = await fetch('/api/players/game/active');
            if (response.ok) {
                const activeGame = await response.json();
                this.gameState = activeGame;
                // Start game scene with active game
                this.scene.start('GameScene', { gameState: activeGame });
                return;
            }
        } catch (error) {
            console.error('Error checking for active game:', error);
        }
        // No active game found, create a new one
        const gameId = IdService.generateGameId();
        this.gameState = {
            id: gameId,
            players: [],
            currentPlayerIndex: 0,
            status: 'setup',
            maxPlayers: 6
        };
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

        // Only proceed with the old setup logic if we're not loading from the lobby
        if (!this.isLobbyGame) {
            // This is the old standalone setup flow - not used when loading from lobby
            console.log('Using old standalone setup flow');
            this.setupStandaloneGame();
        }
        // If we're loading from lobby, the loadSpecificGame method will handle the setup
    }

    private async setupStandaloneGame() {
        // Check for active game first
        try {
            const response = await fetch('/api/players/game/active');
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
            const response = await fetch('/api/players/game/create', {
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
            const response = await fetch('/api/players/create', {
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
                        trainType: 'Freight',  // Default train type
                        turnNumber: 1,
                        trainState: {
                            position: {x: 0, y: 0, row: 0, col: 0},
                            movementHistory: [],
                            remainingMovement: 9
                        },
                        hand: await this.getPlayerHand()
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
            newPlayer.trainType == 'Fast Freight' || newPlayer.trainType == 'Superfreight' ? newPlayer.trainState.remainingMovement = 12 : newPlayer.trainState.remainingMovement = 9;
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
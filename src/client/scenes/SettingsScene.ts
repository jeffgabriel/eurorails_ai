import 'phaser';
import { GameState, Player, PlayerColor } from '../../shared/types/GameTypes';
import { GameScene } from './GameScene';

export class SettingsScene extends Phaser.Scene {
    private gameState: GameState;
    private editingPlayer?: Player;
    private nameInput?: HTMLInputElement;
    private colorButtons: Phaser.GameObjects.Rectangle[] = [];
    private selectedColor?: PlayerColor;
    private errorContainer?: Phaser.GameObjects.Container;

    constructor() {
        super({ key: 'SettingsScene' });
        this.gameState = {
            id: '',  // Empty string as placeholder, will be set in init()
            players: [],
            currentPlayerIndex: 0,
            status: 'setup',
            maxPlayers: 6
        };
    }

    init(data: { gameState: GameState }) {
        this.gameState = data.gameState;
    }

    create() {
        // Clear existing scene
        this.children.removeAll();
        
        // Add semi-transparent dark background for better visibility
        const background = this.add.rectangle(
            0, 0,
            this.scale.width,
            this.scale.height,
            0x000000,
            0.5
        ).setOrigin(0);
        
        // If we're not editing a player, show the main settings menu
        if (!this.editingPlayer) {
            this.showMainSettings();
        }
    }

    private showMainSettings() {
        // Add white background panel for settings
        const panelWidth = 600;
        const panelHeight = Math.max(400, 150 + (this.gameState.players.length * 60) + 200);
        const panel = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2,
            panelWidth,
            panelHeight,
            0xffffff,
            1
        ).setOrigin(0.5);

        // Add title
        this.add.text(
            this.scale.width / 2,
            this.scale.height / 2 - (panelHeight / 2) + 50,
            'Game Settings',
            {
                color: '#000000',
                fontSize: '32px',
                fontStyle: 'bold'
            }
        ).setOrigin(0.5);

        // Add player list with edit/delete buttons
        this.gameState.players.forEach((player, index) => {
            const y = this.scale.height / 2 - (panelHeight / 4) + (index * 60);
            const rowCenter = this.scale.width / 2;

            // Player info
            this.add.text(
                rowCenter - 150,
                y,
                `${player.name}`,
                {
                    color: '#000000',
                    fontSize: '18px'
                }
            ).setOrigin(0, 0.5);

            // Color indicator
            this.add.rectangle(
                rowCenter,
                y,
                30,
                30,
                parseInt(player.color.replace('#', '0x'))
            ).setOrigin(0.5);

            // Edit button
            const editButton = this.add.rectangle(
                rowCenter + 100,
                y,
                80,
                30,
                0x0055aa
            ).setInteractive({ useHandCursor: true });

            this.add.text(
                rowCenter + 100,
                y,
                'Edit',
                {
                    color: '#ffffff',
                    fontSize: '16px'
                }
            ).setOrigin(0.5);

            editButton.on('pointerdown', () => this.showEditPlayer(player));

            // Delete button (only show if more than 2 players)
            if (this.gameState.players.length > 2) {
                const deleteButton = this.add.rectangle(
                    rowCenter + 200,
                    y,
                    80,
                    30,
                    0xaa0000
                ).setInteractive({ useHandCursor: true });

                this.add.text(
                    rowCenter + 200,
                    y,
                    'Delete',
                    {
                        color: '#ffffff',
                        fontSize: '16px'
                    }
                ).setOrigin(0.5);

                deleteButton.on('pointerdown', () => this.deletePlayer(player));
            }
        });

        // Add setup button (only if less than max players)
        if (this.gameState.players.length < this.gameState.maxPlayers) {
            const setupButton = this.add.rectangle(
                this.scale.width / 2,
                this.scale.height / 2 + (panelHeight / 2) - 180,  // Move up
                200,
                45,
                0x00aa00
            ).setInteractive({ useHandCursor: true });

            this.add.text(
                this.scale.width / 2,
                this.scale.height / 2 + (panelHeight / 2) - 180,  // Move up
                'Add New Player',
                {
                    color: '#ffffff',
                    fontSize: '20px'
                }
            ).setOrigin(0.5);

            setupButton.on('pointerdown', () => this.showAddPlayer());
        }

        // Add end game button before the back button
        const endGameButton = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2 + (panelHeight / 2) - 120,
            200,
            45,
            0xff0000
        ).setInteractive({ useHandCursor: true });

        this.add.text(
            this.scale.width / 2,
            this.scale.height / 2 + (panelHeight / 2) - 120,
            'End Game',
            {
                color: '#ffffff',
                fontSize: '20px'
            }
        ).setOrigin(0.5);

        endGameButton.on('pointerdown', () => this.endGame());

        // Add back button
        const backButton = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2 + (panelHeight / 2) - 60,
            200,
            45,
            0x666666
        ).setInteractive({ useHandCursor: true });

        this.add.text(
            this.scale.width / 2,
            this.scale.height / 2 + (panelHeight / 2) - 60,
            'Back to Game',
            {
                color: '#ffffff',
                fontSize: '20px'
            }
        ).setOrigin(0.5);

        backButton.on('pointerdown', () => this.closeSettings());
    }

    private showAddPlayer() {
        // Create a temporary player object for the add flow
        const newPlayer: Player = {
            id: '', // Will be set by the server
            name: '',
            color: PlayerColor.YELLOW, // Default color
            money: 50,
            trainType: 'Freight',
            turnNumber: 1,
            trainState: {
                position: {x: 0, y: 0, row: 0, col: 0},
                movementHistory: [],
                remainingMovement: 9
            },
            hand: []
        };
        
        // Use the existing edit player UI but with different save behavior
        this.editingPlayer = newPlayer;
        this.selectedColor = PlayerColor.YELLOW;
        
        // Show the edit dialog
        this.showEditPlayer(newPlayer, true);
    }

    private showEditPlayer(player: Player, isNewPlayer: boolean = false) {
        this.editingPlayer = player;
        
        // Create semi-transparent dark overlay for the entire screen
        const overlay = this.add.rectangle(
            0, 0,
            this.scale.width,
            this.scale.height,
            0x000000,
            0.7
        ).setOrigin(0);

        // Calculate panel dimensions based on content
        const panelWidth = 500;
        const panelHeight = 400;
        
        // Create edit panel with darker background
        const panel = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2,
            panelWidth,
            panelHeight,
            0x333333
        ).setOrigin(0.5);

        // Add title - moved up slightly
        const title = this.add.text(
            this.scale.width / 2,
            this.scale.height / 2 - 140,
            isNewPlayer ? 'Add New Player' : 'Edit Player',
            {
                color: '#ffffff',
                fontSize: '32px',
                fontStyle: 'bold'
            }
        ).setOrigin(0.5);

        // Create name input - moved up slightly
        const inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.value = player.name;
        inputElement.style.width = '250px';  // Increased width
        inputElement.style.padding = '10px';  // Increased padding
        inputElement.style.fontSize = '18px';  // Increased font size
        inputElement.style.textAlign = 'center';
        inputElement.className = 'settings-scene-element';
        
        const inputContainer = document.createElement('div');
        inputContainer.className = 'settings-scene-element';
        inputContainer.appendChild(inputElement);

        const inputDom = this.add.dom(
            this.scale.width / 2,
            this.scale.height / 2 - 60,  // Moved up to make room for color buttons
            inputContainer
        );
        this.nameInput = inputElement;

        // Create color selection - adjusted spacing
        const colors = Object.entries(PlayerColor);
        const colorSpacing = 70;  // Increased spacing between color buttons
        const startX = this.scale.width / 2 - ((colors.length - 1) * colorSpacing) / 2;
        const colorY = this.scale.height / 2 + 20;  // Adjusted vertical position

        this.colorButtons = colors.map(([name, color], index) => {
            const x = startX + (index * colorSpacing);
            const colorButton = this.add.rectangle(x, colorY, 50, 50, parseInt(color.replace('#', '0x')));  // Larger color buttons
            
            colorButton.setInteractive({ useHandCursor: true });
            colorButton.setStrokeStyle(color === player.color ? 4 : 0, 0xffffff);

            colorButton.on('pointerdown', () => {
                this.selectedColor = color as PlayerColor;
                this.colorButtons.forEach(btn => {
                    btn.setStrokeStyle(btn === colorButton ? 4 : 0, 0xffffff);
                });
            });

            // Add color name below - adjusted position
            this.add.text(x, colorY + 40, name, {
                color: '#ffffff',
                fontSize: '14px'
            }).setOrigin(0.5);

            return colorButton;
        });

        // Add save button - adjusted position
        const saveButton = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2 + 100,
            160,
            45,
            0x00aa00
        ).setInteractive({ useHandCursor: true });

        this.add.text(
            this.scale.width / 2,
            this.scale.height / 2 + 100,
            isNewPlayer ? 'Add' : 'Save',
            {
                color: '#ffffff',
                fontSize: '20px'
            }
        ).setOrigin(0.5);

        saveButton.on('pointerdown', () => {
            if (isNewPlayer) {
                this.addNewPlayer();
            } else {
                this.savePlayerChanges();
            }
        });

        // Add cancel button - adjusted position
        const cancelButton = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2 + 160,  // More space between buttons
            160,  // Wider button
            45,   // Taller button
            0xaa0000
        ).setInteractive({ useHandCursor: true });

        this.add.text(
            this.scale.width / 2,
            this.scale.height / 2 + 160,
            'Cancel',
            {
                color: '#ffffff',
                fontSize: '20px'  // Larger font
            }
        ).setOrigin(0.5);

        cancelButton.on('pointerdown', () => this.closeEditDialog());
    }

    private closeEditDialog() {
        // Clean up only settings scene DOM elements
        const settingsElements = document.querySelectorAll('.settings-scene-element');
        settingsElements.forEach(element => element.remove());

        // Clean up any remaining input references
        if (this.nameInput) {
            this.nameInput = undefined;
        }

        // Reset editing state
        this.editingPlayer = undefined;
        this.selectedColor = undefined;

        // Refresh the main settings display
        this.create();
    }

    private async savePlayerChanges() {
        if (!this.editingPlayer || !this.nameInput) return;

        const newName = this.nameInput.value.trim();
        if (!newName) {
            this.showErrorMessage('Please enter a valid name');
            return;
        }

        try {
            // Update player locally first
            const updatedPlayer = {
                ...this.editingPlayer,
                name: newName,
                color: this.selectedColor || this.editingPlayer.color
            };

            // Log the request payload
            console.log('Saving player changes with payload:', {
                gameId: this.gameState.id,
                player: updatedPlayer
            });

            // Save to database
            const response = await fetch('/api/players/update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    player: updatedPlayer
                })
            });

            console.log('Server response status:', response.status);
            
            // Log headers in a TypeScript-friendly way
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                headers[key] = value;
            });
            console.log('Response headers:', headers);

            // Try to get response body regardless of status
            const responseText = await response.text();
            console.log('Raw response body:', responseText);

            let errorData;
            try {
                errorData = JSON.parse(responseText);
            } catch (parseError) {
                console.error('Failed to parse response as JSON:', parseError);
                throw new Error('Server returned invalid JSON response');
            }

            if (!response.ok) {
                throw new Error(errorData.error || 'Failed to update player');
            }

            // Update local state only after successful save
            const playerIndex = this.gameState.players.findIndex(p => p.id === this.editingPlayer!.id);
            if (playerIndex !== -1) {
                this.gameState.players[playerIndex] = updatedPlayer;
                console.log('Successfully updated player in local state:', updatedPlayer);
            }

            // Close just the edit dialog and return to main settings
            this.closeEditDialog();
        } catch (error) {
            console.error('Error saving player changes:', error);
            this.showErrorMessage(error instanceof Error ? error.message : 'Failed to save changes. Please try again.');
        }
    }

    private async deletePlayer(player: Player) {
        try {
            const response = await fetch('/api/players/delete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    playerId: player.id
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to delete player');
            }

            // Update local state
            const index = this.gameState.players.indexOf(player);
            if (index > -1) {
                this.gameState.players.splice(index, 1);
                // Adjust currentPlayerIndex if needed
                if (this.gameState.currentPlayerIndex >= this.gameState.players.length) {
                    this.gameState.currentPlayerIndex = 0;
                }
            }

            this.create();
        } catch (error) {
            console.error('Error deleting player:', error);
            this.showErrorMessage(error instanceof Error ? error.message : 'Failed to delete player. Please try again.');
        }
    }

    private async addNewPlayer() {
        if (!this.editingPlayer || !this.nameInput) return;

        const newName = this.nameInput.value.trim();
        if (!newName) {
            this.showErrorMessage('Please enter a valid name');
            return;
        }

        // Check for duplicate names
        const isDuplicateName = this.gameState.players.some(
            player => player.name.toLowerCase() === newName.toLowerCase()
        );

        if (isDuplicateName) {
            this.showErrorMessage('A player with this name already exists');
            return;
        }

        try {
            const playerData = {
                name: newName,
                color: this.selectedColor || PlayerColor.YELLOW,
                money: 50,
                trainType: 'Freight'
            };

            console.log('Creating new player with data:', playerData);

            // Save to database using the create endpoint
            const response = await fetch('/api/players/create', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    player: playerData
                })
            });

            const responseText = await response.text();
            console.log('Server response:', responseText);

            if (!response.ok) {
                let errorMessage = 'Failed to create player';
                try {
                    const errorData = JSON.parse(responseText);
                    if (errorData.details?.includes('duplicate key')) {
                        errorMessage = 'A player with this name already exists';
                    } else {
                        errorMessage = errorData.error || errorMessage;
                    }
                } catch (e) {
                    // If we can't parse the error, use the raw text
                    errorMessage = responseText || errorMessage;
                }
                throw new Error(errorMessage);
            }

            let newPlayer;
            try {
                newPlayer = JSON.parse(responseText);
            } catch (e) {
                console.error('Failed to parse server response:', e);
                throw new Error('Invalid server response');
            }

            // Update local state with the server response
            this.gameState.players.push(newPlayer);
            console.log('Added new player to game state:', newPlayer);

            // Close the dialog and refresh the display
            this.closeEditDialog();
        } catch (error) {
            console.error('Error creating player:', error);
            this.showErrorMessage(error instanceof Error ? error.message : 'Failed to create player. Please try again.');
        }
    }

    private showErrorMessage(message: string) {
        // Remove existing error container if it exists
        if (this.errorContainer) {
            this.errorContainer.destroy();
        }

        // Create new error container at the bottom of the screen
        this.errorContainer = this.add.container(this.scale.width / 2, this.scale.height - 50);
        
        // Add semi-transparent red background
        const bg = this.add.rectangle(0, 0, 400, 40, 0xff0000, 0.8);
        
        // Add error message text
        const text = this.add.text(0, 0, message, {
            color: '#ffffff',
            fontSize: '16px',
            fontStyle: 'bold'
        }).setOrigin(0.5);
        
        this.errorContainer.add([bg, text]);
        
        // Auto-hide after 3 seconds
        this.time.delayedCall(3000, () => {
            if (this.errorContainer) {
                this.errorContainer.destroy();
                this.errorContainer = undefined;
            }
        });
    }

    private closeSettings() {
        // Clean up only settings scene DOM elements
        const settingsElements = document.querySelectorAll('.settings-scene-element');
        settingsElements.forEach(element => element.remove());

        // Clean up any remaining input references
        if (this.nameInput) {
            this.nameInput = undefined;
        }

        // Get the game scene and update its state
        const gameScene = this.scene.get('GameScene') as GameScene;
        
        // Update game state while preserving camera state
        gameScene.gameState = {
            ...this.gameState,
            cameraState: gameScene.gameState.cameraState || this.gameState.cameraState
        };

        // Stop this scene first
        this.scene.stop();

        // Just resume the game scene, no need to restart
        this.scene.resume('GameScene');
        
        // Refresh UI elements without restarting the scene
        gameScene.events.emit('resume');
    }

    private async endGame() {
        try {
            const response = await fetch(`/api/players/game/${this.gameState.id}/end`, {
                method: 'POST'
            });

            if (!response.ok) {
                throw new Error('Failed to end game');
            }

            // Stop all current scenes
            this.scene.stop('GameScene');
            this.scene.stop('SettingsScene');

            // Start fresh with SetupScene and pass empty game state to force new game creation
            this.scene.start('SetupScene', { 
                gameState: {
                    id: '',
                    players: [],
                    currentPlayerIndex: 0,
                    status: 'setup',
                    maxPlayers: 6
                }
            });
        } catch (error) {
            console.error('Error ending game:', error);
            this.showErrorMessage('Failed to end game');
        }
    }
} 
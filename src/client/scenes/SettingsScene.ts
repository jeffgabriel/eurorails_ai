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
            gamePhase: 'setup',
            maxPlayers: 6
        };
    }

    init(data: { gameState: GameState }) {
        this.gameState = data.gameState;
    }

    create() {
        // Clear existing scene
        this.children.removeAll();
        
        // If we're not editing a player, show the main settings menu
        if (!this.editingPlayer) {
            this.showMainSettings();
        }
    }

    private showMainSettings() {
        // Add title
        this.add.text(
            this.scale.width / 2,
            50,
            'Game Settings',
            {
                color: '#000000',
                fontSize: '32px',
                fontStyle: 'bold'
            }
        ).setOrigin(0.5);

        // Add player list with edit/delete buttons
        this.gameState.players.forEach((player, index) => {
            const y = 150 + (index * 60);

            // Player info
            this.add.text(
                100,
                y,
                `${player.name}`,
                {
                    color: '#000000',
                    fontSize: '18px'
                }
            );

            // Color indicator
            this.add.rectangle(
                300,
                y + 10,
                30,
                30,
                parseInt(player.color.replace('#', '0x'))
            );

            // Edit button
            const editButton = this.add.rectangle(
                400,
                y + 10,
                80,
                30,
                0x0055aa
            ).setInteractive({ useHandCursor: true });

            this.add.text(
                400,
                y + 10,
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
                    500,
                    y + 10,
                    80,
                    30,
                    0xaa0000
                ).setInteractive({ useHandCursor: true });

                this.add.text(
                    500,
                    y + 10,
                    'Delete',
                    {
                        color: '#ffffff',
                        fontSize: '16px'
                    }
                ).setOrigin(0.5);

                deleteButton.on('pointerdown', () => this.deletePlayer(player));
            }
        });

        // Add back button
        const backButton = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height - 100,
            200,
            40,
            0x666666
        ).setInteractive({ useHandCursor: true });

        this.add.text(
            this.scale.width / 2,
            this.scale.height - 100,
            'Back to Game',
            {
                color: '#ffffff',
                fontSize: '18px'
            }
        ).setOrigin(0.5);

        backButton.on('pointerdown', () => this.closeSettings());
    }

    private showEditPlayer(player: Player) {
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
        const panelWidth = 500;  // Increased from 400 to accommodate color buttons
        const panelHeight = 400;  // Increased from 300 to give more vertical space
        
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
            'Edit Player',
            {
                color: '#ffffff',
                fontSize: '32px',  // Increased font size
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
            160,  // Wider button
            45,   // Taller button
            0x00aa00
        ).setInteractive({ useHandCursor: true });

        this.add.text(
            this.scale.width / 2,
            this.scale.height / 2 + 100,
            'Save',
            {
                color: '#ffffff',
                fontSize: '20px'  // Larger font
            }
        ).setOrigin(0.5);

        saveButton.on('pointerdown', () => this.savePlayerChanges());

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
        gameScene.gameState = this.gameState;

        // Stop this scene first
        this.scene.stop();

        // Resume and restart game scene to ensure proper initialization
        this.scene.resume('GameScene');
        gameScene.scene.restart({ gameState: this.gameState });
    }
} 
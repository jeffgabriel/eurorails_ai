import 'phaser';
import { Player, PlayerColor, GameState, INITIAL_PLAYER_MONEY } from '../../shared/types/GameTypes';
import { GameScene } from './GameScene';
import { IdService } from '../../shared/services/IdService';

export class SetupScene extends Phaser.Scene {
    private gameState: GameState;
    private nameInput?: HTMLInputElement;
    private colorButtons: Phaser.GameObjects.Rectangle[] = [];
    private selectedColor?: PlayerColor;
    private errorText?: Phaser.GameObjects.Text;
    private playerList?: Phaser.GameObjects.Text;

    constructor(gameState: GameState) {
        super({ 
            key: 'SetupScene',
            active: true
        });
        this.gameState = gameState;
    }

    preload() {
        // Set background color
        this.cameras.main.setBackgroundColor('#ffffff');
    }

    create() {
        // Check if we already have players from GameScene
        const gameScene = this.scene.get('GameScene') as GameScene;
        if (gameScene.gameState?.players?.length > 0) {
            this.scene.start('GameScene', { gameState: gameScene.gameState });
            return;
        }

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
        const startX = 250;
        const spacing = 60;

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
                        trainType: 'Freight'  // Default train type
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

    private startGame() {
        if (this.gameState.players.length < 2) {
            this.showError('At least 2 players are required to start');
            return;
        }

        // Store game state and switch to game scene
        this.scene.start('GameScene', { gameState: this.gameState });
    }
} 
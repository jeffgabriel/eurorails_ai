import 'phaser';
import { Player, PlayerColor, GameState, INITIAL_PLAYER_MONEY } from '../../shared/types/GameTypes';
import { GameScene } from './GameScene';
import { IdService } from '../../shared/services/IdService';

export class SetupScene extends Phaser.Scene {
    private gameState: GameState = {
        id: IdService.generateGameId(),
        players: [],
        currentPlayerIndex: 0,
        gamePhase: 'setup',
        maxPlayers: 6
    };
    private nameInput?: HTMLInputElement;
    private colorButtons: Phaser.GameObjects.Rectangle[] = [];
    private selectedColor?: PlayerColor;
    private errorText?: Phaser.GameObjects.Text;
    private playerList?: Phaser.GameObjects.Text;

    constructor() {
        super({ 
            key: 'SetupScene',
            active: true
        });
    }

    create() {
        // Check if we already have players from GameScene
        const gameScene = this.scene.get('GameScene') as GameScene;
        if (gameScene.gameState?.players?.length > 0) {
            this.scene.start('GameScene', { gameState: gameScene.gameState });
            return;
        }

        // Add title
        this.add.text(400, 50, 'Player Setup', {
            color: '#000000',
            fontSize: '32px'
        }).setOrigin(0.5);

        // Add instructions
        this.add.text(400, 100, 'Enter player name and select color\n(2-6 players required)', {
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

        const domElement = this.add.dom(400, 200, inputContainer);
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
        const addButton = this.add.rectangle(400, 400, 200, 40, 0x00aa00);
        const addButtonText = this.add.text(400, 400, 'Add Player', {
            color: '#ffffff',
            fontSize: '18px'
        }).setOrigin(0.5);

        addButton.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.addPlayer())
            .on('pointerover', () => addButton.setFillStyle(0x008800))
            .on('pointerout', () => addButton.setFillStyle(0x00aa00));

        // Start game button
        const startButton = this.add.rectangle(400, 500, 200, 40, 0x0055aa);
        const startButtonText = this.add.text(400, 500, 'Start Game', {
            color: '#ffffff',
            fontSize: '18px'
        }).setOrigin(0.5);

        startButton.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.startGame())
            .on('pointerover', () => startButton.setFillStyle(0x004488))
            .on('pointerout', () => startButton.setFillStyle(0x0055aa));

        // Error text
        this.errorText = this.add.text(400, 450, '', {
            color: '#ff0000',
            fontSize: '16px'
        }).setOrigin(0.5);

        // Player list
        this.playerList = this.add.text(600, 200, 'Current Players:', {
            color: '#000000',
            fontSize: '16px'
        });

        this.updatePlayerList();
    }

    private addPlayer() {
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

        // Add new player with generated ID
        const newPlayer: Player = {
            id: IdService.generatePlayerId(),
            name,
            color: this.selectedColor,
            money: INITIAL_PLAYER_MONEY,
            trainType: 'Freight'  // Default train type
        };

        this.gameState.players.push(newPlayer);
        this.updatePlayerList();

        // Reset input
        this.nameInput.value = '';
        this.selectedColor = undefined;
        this.colorButtons.forEach(btn => btn.setStrokeStyle());
        this.showError('');
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
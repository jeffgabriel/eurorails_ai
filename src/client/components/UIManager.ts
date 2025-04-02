import 'phaser';
import { GameState } from '../../shared/types/GameTypes';

export class UIManager {
    private scene: Phaser.Scene;
    private gameState: GameState;
    private uiContainer: Phaser.GameObjects.Container;
    private playerHandContainer: Phaser.GameObjects.Container;
    private toggleDrawingCallback: () => void;
    private nextPlayerCallback: () => void;
    private openSettingsCallback: () => void;

    constructor(
        scene: Phaser.Scene, 
        gameState: GameState,
        toggleDrawingCallback: () => void,
        nextPlayerCallback: () => void,
        openSettingsCallback: () => void
    ) {
        this.scene = scene;
        this.gameState = gameState;
        this.toggleDrawingCallback = toggleDrawingCallback;
        this.nextPlayerCallback = nextPlayerCallback;
        this.openSettingsCallback = openSettingsCallback;
        
        // Create containers
        this.uiContainer = this.scene.add.container(0, 0);
        this.playerHandContainer = this.scene.add.container(0, 0);
    }

    public getContainers(): { uiContainer: Phaser.GameObjects.Container, playerHandContainer: Phaser.GameObjects.Container } {
        return {
            uiContainer: this.uiContainer,
            playerHandContainer: this.playerHandContainer
        };
    }

    public setupUIOverlay(): void {
        if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
            return;
        }

        // Clear existing UI
        this.uiContainer.removeAll(true);

        const LEADERBOARD_WIDTH = 150;
        const LEADERBOARD_PADDING = 10;
        
        // Add settings button
        const settingsButton = this.scene.add.rectangle(
            LEADERBOARD_PADDING,
            LEADERBOARD_PADDING,
            40,
            40,
            0x444444,
            0.9
        ).setOrigin(0, 0);

        const settingsIcon = this.scene.add.text(
            LEADERBOARD_PADDING + 20,
            LEADERBOARD_PADDING + 20,
            '⚙️',
            { fontSize: '24px' }
        ).setOrigin(0.5);

        settingsButton.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.openSettingsCallback())
            .on('pointerover', () => settingsButton.setFillStyle(0x555555))
            .on('pointerout', () => settingsButton.setFillStyle(0x444444));

        // Create semi-transparent background for leaderboard
        const leaderboardHeight = 40 + (this.gameState.players.length * 20) + 50; // Added height for next player button
        const leaderboardBg = this.scene.add.rectangle(
            this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
            LEADERBOARD_PADDING,
            LEADERBOARD_WIDTH,
            leaderboardHeight,
            0x333333,
            0.9
        ).setOrigin(0, 0);
        
        // Add leaderboard title
        const leaderboardTitle = this.scene.add.text(
            this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING + (LEADERBOARD_WIDTH / 2),
            LEADERBOARD_PADDING + 5,
            'Players',
            { 
                color: '#ffffff',
                fontSize: '16px',
                fontStyle: 'bold'
            }
        ).setOrigin(0.5, 0);
        
        // Add all player entries
        const playerEntries = this.gameState.players.map((player, index) => {
            const isCurrentPlayer = index === this.gameState.currentPlayerIndex;
            
            // Create background highlight for current player
            let entryBg;
            if (isCurrentPlayer) {
                entryBg = this.scene.add.rectangle(
                    this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
                    LEADERBOARD_PADDING + 30 + (index * 20),
                    LEADERBOARD_WIDTH,
                    20,
                    0x666666,
                    0.5
                ).setOrigin(0, 0);
            }
            
            // Create player text
            const playerText = this.scene.add.text(
                this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING + 5,
                LEADERBOARD_PADDING + 30 + (index * 20),
                `${isCurrentPlayer ? '►' : ' '} ${player.name}`,
                { 
                    color: '#ffffff',
                    fontSize: '14px',
                    fontStyle: isCurrentPlayer ? 'bold' : 'normal'
                }
            ).setOrigin(0, 0);

            // Create money text (right-aligned)
            const moneyText = this.scene.add.text(
                this.scene.scale.width - LEADERBOARD_PADDING - 5,
                LEADERBOARD_PADDING + 30 + (index * 20),
                `${player.money}M`,
                { 
                    color: '#ffffff',
                    fontSize: '14px',
                    fontStyle: isCurrentPlayer ? 'bold' : 'normal'
                }
            ).setOrigin(1, 0);  // Right-align

            // Return all elements for this player
            return entryBg ? [entryBg, playerText, moneyText] : [playerText, moneyText];
        }).flat();  // Flatten the array of arrays

        // Add next player button
        const nextPlayerButton = this.scene.add.rectangle(
            this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
            LEADERBOARD_PADDING + 40 + (this.gameState.players.length * 20),
            LEADERBOARD_WIDTH,
            40,
            0x00aa00,
            0.9
        ).setOrigin(0, 0);

        const nextPlayerText = this.scene.add.text(
            this.scene.scale.width - LEADERBOARD_WIDTH / 2 - LEADERBOARD_PADDING,
            LEADERBOARD_PADDING + 60 + (this.gameState.players.length * 20),
            'Next Player',
            { 
                color: '#ffffff',
                fontSize: '16px',
                fontStyle: 'bold'
            }
        ).setOrigin(0.5, 0.5);

        // Make the button interactive
        nextPlayerButton.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.nextPlayerCallback())
            .on('pointerover', () => nextPlayerButton.setFillStyle(0x008800))
            .on('pointerout', () => nextPlayerButton.setFillStyle(0x00aa00));
        
        this.uiContainer.add([leaderboardBg, leaderboardTitle, ...playerEntries, nextPlayerButton, nextPlayerText, settingsButton, settingsIcon]);
    }

    public setupPlayerHand(isDrawingMode: boolean = false, currentTrackCost: number = 0): void {
        if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
            return;
        }

        // Clear existing UI
        this.playerHandContainer.removeAll(true);

        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        
        // Create background for player's hand area
        const handBackground = this.scene.add.rectangle(
            0,
            this.scene.scale.height - 200,  // Position from bottom of screen
            this.scene.scale.width,
            200,
            0x333333,
            0.8
        ).setOrigin(0, 0);
        
        // Add sections for demand cards (3 slots)
        for (let i = 0; i < 3; i++) {
            // Create card background
            const cardSlot = this.scene.add.rectangle(
                30 + (i * 180),  // Space cards horizontally
                this.scene.scale.height - 180,  // Position relative to bottom
                150,  // Card width
                160,  // Card height
                0x666666
            ).setOrigin(0, 0);
            
            // Add card label
            const cardLabel = this.scene.add.text(
                30 + (i * 180) + 75,  // Center text above card
                this.scene.scale.height - 195,  // Position above card
                `Demand Card ${i + 1}`,
                { 
                    color: '#ffffff', 
                    fontSize: '14px' 
                }
            ).setOrigin(0.5, 0);
            
            this.playerHandContainer.add([cardSlot, cardLabel]);
        }
        
        // Create train card section
        const trainSection = this.scene.add.rectangle(
            600,  // Position after demand cards
            this.scene.scale.height - 180,  // Align with demand cards
            180,  // Width
            160,  // Height
            0x666666
        ).setOrigin(0, 0);
        
        const trainLabel = this.scene.add.text(
            690,  // Center above train card
            this.scene.scale.height - 195,  // Align with other labels
            `${currentPlayer.trainType}`,
            { 
                color: '#ffffff', 
                fontSize: '14px' 
            }
        ).setOrigin(0.5, 0);
        
        // Add player info with track cost if in drawing mode
        let playerInfoText = `${currentPlayer.name}\nMoney: ECU ${currentPlayer.money}M`;
        
        // Add track cost display when in drawing mode
        if (isDrawingMode) {
            // Show the cost even if zero, with more descriptive label
            playerInfoText += `\nECU ${currentTrackCost}M`;
        }
        
        const playerInfo = this.scene.add.text(
            820,  // Position after train card
            this.scene.scale.height - 180,  // Align with cards
            playerInfoText,
            { 
                color: '#ffffff',  // Changed to white for better visibility
                fontSize: '20px',
                fontStyle: 'bold'
            }
        ).setOrigin(0, 0);

        // Add crayon button
        const colorMap: { [key: string]: string } = {
            '#FFD700': 'yellow',
            '#FF0000': 'red',
            '#0000FF': 'blue',
            '#000000': 'black',
            '#008000': 'green',
            '#8B4513': 'brown'
        };
        
        const crayonColor = colorMap[currentPlayer.color.toUpperCase()] || 'black';
        const crayonTexture = `crayon_${crayonColor}`;
        
        // Position crayon relative to player info
        const crayonButton = this.scene.add.image(
            820 + 200,  // Position 200 pixels right of player info start
            this.scene.scale.height - 140,  // Vertically center between player info lines
            crayonTexture
        ).setScale(0.15)
        .setInteractive({ useHandCursor: true });

        // Add hover effect and click handler
        // Set appropriate initial scale based on drawing mode
        if (isDrawingMode) {
            crayonButton.setScale(0.18);  // Larger scale when in drawing mode
        }
        
        crayonButton
            .on('pointerover', () => {
                if (!isDrawingMode) {
                    crayonButton.setScale(0.17);
                }
            })
            .on('pointerout', () => {
                if (!isDrawingMode) {
                    crayonButton.setScale(0.15);
                }
            })
            .on('pointerdown', (pointer: Phaser.Input.Pointer) => {
                pointer.event.stopPropagation();  // Prevent click from propagating
                this.toggleDrawingCallback();
            });
            
        // Add visual indicator for drawing mode
        if (isDrawingMode) {
            // Add glowing effect or highlight around the crayon
            const highlight = this.scene.add.circle(
                crayonButton.x,
                crayonButton.y,
                30,  // Radius slightly larger than the crayon
                0xffff00,  // Yellow glow
                0.3  // Semi-transparent
            );
            this.playerHandContainer.add(highlight);
        }
        
        // Add elements to container in correct order
        this.playerHandContainer.add([handBackground]);  // Add background first
        this.playerHandContainer.add([trainSection, trainLabel, playerInfo, crayonButton]);  // Then add UI elements
    }
}
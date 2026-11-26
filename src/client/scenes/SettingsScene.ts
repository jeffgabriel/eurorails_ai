import 'phaser';
import { FullGameState, Player, PlayerColor } from '../../shared/types/GameTypes';
import { GameScene } from './GameScene';
import { config } from '../config/apiConfig';
import { authenticatedFetch } from '../services/authenticatedFetch';
import { UI_FONT_FAMILY } from '../config/uiFont';
import { CityListDropDown } from '../components/CityListDropDown';
import { CityListItem } from '../components/CityListDropDown';

export class SettingsScene extends Phaser.Scene {
    private gameState: FullGameState;
    private editingPlayer?: Player;
    private nameInput?: HTMLInputElement;
    private cityDropDown?: CityListDropDown;
    private colorButtons: Phaser.GameObjects.Rectangle[] = [];
    private selectedColor?: PlayerColor;
    private errorContainer?: Phaser.GameObjects.Container;
    private joinCode?: string;
    /** User id of the game's creator, who alone may delete players and end the game. */
    private creatorUserId?: string;
    /** Game the join code and creator were fetched for. */
    private lobbyInfoGameId?: string;
    private activeTab: 'players' | 'rules' = 'players';

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

    init(data: { gameState: FullGameState }) {
        this.gameState = data.gameState;
        // Re-read the join code and creator each time Settings opens: the scene
        // instance is reused, and the creator changes if the old one leaves.
        this.joinCode = undefined;
        this.creatorUserId = undefined;
        this.lobbyInfoGameId = undefined;
    }

    /** The signed-in user's id (same source PlayerStateService uses). */
    private getLocalUserId(): string | null {
        try {
            const userJson = localStorage.getItem('eurorails.user');
            return userJson ? (JSON.parse(userJson)?.id ?? null) : null;
        } catch {
            return null;
        }
    }

    private isLocalUserCreator(): boolean {
        const userId = this.getLocalUserId();
        return !!userId && userId === this.creatorUserId;
    }

    private isOwnPlayer(player: Player): boolean {
        const userId = this.getLocalUserId();
        return !!userId && player.userId === userId;
    }

    async create() {
        await this.renderScene();
    }

    private async renderScene(): Promise<void> {
        // Clean up only settings scene DOM elements
        const settingsElements = document.querySelectorAll('.settings-scene-element');
        settingsElements.forEach(element => element.remove());

        // Clear existing scene
        this.children.removeAll();
        
        // Add semi-transparent dark background for better visibility
        this.add.rectangle(
            0, 0,
            this.scale.width,
            this.scale.height,
            0x000000,
            0.5
        ).setOrigin(0);
        
        // Fetch join code if we have a game ID
        if (this.gameState.id && this.lobbyInfoGameId !== this.gameState.id) {
            try {
                const response = await authenticatedFetch(`${config.apiBaseUrl}/api/lobby/games/${this.gameState.id}`);
                if (response.ok) {
                    const data = await response.json();
                    this.joinCode = data.data?.joinCode;
                    this.creatorUserId = data.data?.createdBy ?? undefined;
                    this.lobbyInfoGameId = this.gameState.id;
                }
            } catch (error) {
                console.error('Failed to fetch join code:', error);
            }
        }

        // If we're editing a player, always re-render the edit dialog so we never strand the user
        // on an empty overlay if something triggers a rerender (e.g., clicks falling through).
        if (this.editingPlayer) {
            this.showEditPlayer(this.editingPlayer);
            return;
        }

        this.showMainSettings();
    }

    private showMainSettings() {
        // Add white background panel for settings
        const panelWidth = 600;
        const joinCodeHeight = this.joinCode ? 80 : 0;
        const tabHeaderHeight = 50;
        const citySearchHeight = 90;
        const contentHeight =
            this.activeTab === 'players'
                ? (this.gameState.players.length * 60) + citySearchHeight
                : 340;
        const showBottomButtons = this.activeTab === 'players';
        const bottomButtonsHeight = showBottomButtons ? 160 : 0;
        const panelHeight = Math.min(
            this.scale.height - 40,
            Math.max(420, 170 + tabHeaderHeight + joinCodeHeight + contentHeight + bottomButtonsHeight)
        );
        const panel = this.add.rectangle(
            this.scale.width / 2,
            this.scale.height / 2,
            panelWidth,
            panelHeight,
            0xffffff,
            1
        ).setOrigin(0.5);

        const panelLeftX = (this.scale.width / 2) - (panelWidth / 2);
        const panelTopY = (this.scale.height / 2) - (panelHeight / 2);

        // Add title
        this.add.text(
            this.scale.width / 2,
            this.scale.height / 2 - (panelHeight / 2) + 50,
            'Game Settings',
            {
                color: '#000000',
                fontSize: '32px',
                fontStyle: 'bold',
                fontFamily: UI_FONT_FAMILY
            }
        ).setOrigin(0.5);

        // Top-right close button (always available, regardless of tab/content height)
        const closeSize = 28;
        const closeX = panelLeftX + panelWidth - 22;
        const closeY = panelTopY + 22;

        const closeBg = this.add.rectangle(
            closeX,
            closeY,
            closeSize,
            closeSize,
            0xdddddd
        ).setOrigin(0.5).setInteractive({ useHandCursor: true });

        this.add.text(
            closeX,
            closeY + 1,
            '✕',
            {
                color: '#000000',
                fontSize: '18px',
                fontStyle: 'bold',
                fontFamily: UI_FONT_FAMILY
            }
        ).setOrigin(0.5);

        closeBg.on('pointerdown', () => this.closeSettings());

        // Tabs row
        const tabsY = panelTopY + 95;
        const tabW = 140;
        const tabH = 34;
        const tabGap = 14;
        const tabsXLeft = (this.scale.width / 2) - (tabW + tabGap / 2);
        const tabsXRight = (this.scale.width / 2) + (tabW + tabGap / 2) - tabW;

        const makeTabButton = (
            label: string,
            tab: 'players' | 'rules',
            x: number
        ) => {
            const isActive = this.activeTab === tab;
            const rect = this.add.rectangle(
                x,
                tabsY,
                tabW,
                tabH,
                isActive ? 0x2563eb : 0xdddddd
            ).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });

            this.add.text(
                x + (tabW / 2),
                tabsY,
                label,
                {
                    color: isActive ? '#ffffff' : '#000000',
                    fontSize: '16px',
                    fontStyle: 'bold',
                    fontFamily: UI_FONT_FAMILY
                }
            ).setOrigin(0.5);

            rect.on('pointerdown', () => {
                if (this.editingPlayer) return;
                if (this.activeTab === tab) return;
                this.activeTab = tab;
                this.renderScene().catch(console.error);
            });
        };

        makeTabButton('Players', 'players', tabsXLeft);
        makeTabButton('Rules', 'rules', tabsXRight);

        // Add join code display
        if (this.joinCode) {
            const joinCodeY = panelTopY + 140;
            this.add.text(
                this.scale.width / 2,
                joinCodeY,
                'Join Code:',
                {
                    color: '#666666',
                    fontSize: '16px',
                    fontFamily: UI_FONT_FAMILY
                }
            ).setOrigin(0.5);
            
            this.add.text(
                this.scale.width / 2,
                joinCodeY + 25,
                this.joinCode,
                {
                    color: '#000000',
                    fontSize: '24px',
                    fontStyle: 'bold',
                    fontFamily: 'monospace'
                }
            ).setOrigin(0.5);
        }

        // Content region (above the bottom button block)
        const contentTopY = this.joinCode ? panelTopY + 185 : panelTopY + 135;

        if (this.activeTab === 'players') {
            // Add player list with edit/delete buttons
            const playerListStartY = contentTopY + 20;
            const isCreator = this.isLocalUserCreator();
            this.gameState.players.forEach((player, index) => {
                const y = playerListStartY + (index * 60);
                const rowCenter = this.scale.width / 2;

                // Player info
                this.add.text(
                    rowCenter - 150,
                    y,
                    `${player.name}`,
                    {
                        color: '#000000',
                        fontSize: '18px',
                        fontFamily: UI_FONT_FAMILY
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

                const isOwn = this.isOwnPlayer(player);

                // Edit button (your own row only)
                if (isOwn) {
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
                            fontSize: '16px',
                            fontFamily: UI_FONT_FAMILY
                        }
                    ).setOrigin(0.5);

                    editButton.on('pointerdown', () => this.showEditPlayer(player));
                }

                // Delete button (creator only, never their own row, and only with more than 2 players)
                if (isCreator && !isOwn && this.gameState.players.length > 2) {
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
                            fontSize: '16px',
                            fontFamily: UI_FONT_FAMILY
                        }
                    ).setOrigin(0.5);

                    deleteButton.on('pointerdown', () => this.deletePlayer(player));
                }
            });
        } else {
            const rulesLeftX = (this.scale.width / 2) - (panelWidth / 2) + 30;
            const rulesWidth = panelWidth - 60;

            const rulesText =
                "Turn summary:\n" +
                "- Move train first (move, load/unload, pay fees, collect payoffs)\n" +
                "- Then build track OR upgrade (spend up to ECU 20M per turn)\n\n" +
                "Track building:\n" +
                "- Build from any major city milepost or from your existing network\n" +
                "- Costs: Clear 1M, Mountain 2M, Alpine 5M, Small/Medium 3M, Major 5M\n" +
                "- Water crossing adds: River +2M, Lake +3M, Ocean inlet +3M\n\n" +
                "Movement & fees:\n" +
                "- Freight/Heavy: 9 mileposts; Fast/Super: 12 mileposts\n" +
                "- Own track: free; Opponent track: pay ECU 4M per opponent used (per turn)\n" +
                "- Reverse only at cities (major city / ferry port)\n\n" +
                "Loads & demand cards:\n" +
                "- Pick up a load by passing through a producing city (no card required)\n" +
                "- Deliver to satisfy a matching Demand card: discard card, get payoff, return chip, draw back to 3\n" +
                "- Drop a load at any city (no payoff)\n\n" +
                "Events:\n" +
                "- Event cards take effect immediately; keep drawing until you have 3 Demand cards.";

            this.add.text(
                rulesLeftX,
                contentTopY,
                rulesText,
                {
                    color: '#000000',
                    fontSize: '15px',
                    fontFamily: UI_FONT_FAMILY,
                    wordWrap: { width: rulesWidth, useAdvancedWrap: true }
                }
            ).setOrigin(0, 0);
        }

        if (showBottomButtons) {
            // --- Button block layout ---
            // Keep buttons nicely spaced and centered within the panel regardless of panelHeight.
            const buttonX = this.scale.width / 2;
            const panelBottomY = this.scale.height / 2 + (panelHeight / 2);
            const buttonWidth = 260;
            const buttonHeight = 48;
            const buttonGap = 14;
            const bottomPadding = 48;
            const bottomButtons: Array<{ label: string; color: number; onClick: () => void }> = [];
            if (this.isLocalUserCreator()) {
                bottomButtons.push({ label: 'End Game', color: 0xff0000, onClick: () => this.endGame() });
            }
            bottomButtons.push({
                label: 'Back to Lobby',
                color: 0x2563eb,
                onClick: () => {
                    // Do not end the game; just return to the lobby UI.
                    // Use a full navigation since Phaser is running outside React.
                    window.location.href = '/lobby';
                },
            });
            bottomButtons.push({ label: 'Back to Game', color: 0x666666, onClick: () => this.closeSettings() });
            const buttonCount = bottomButtons.length;
            const blockHeight = (buttonCount * buttonHeight) + ((buttonCount - 1) * buttonGap);
            const blockTopY = panelBottomY - bottomPadding - blockHeight;

            const yForButtonIndex = (idx: number) =>
                blockTopY + (buttonHeight / 2) + idx * (buttonHeight + buttonGap);

            // --- City search ("Take me to...") --- (Players tab only)
            const gameScene = this.scene.get('GameScene') as GameScene;
            const mapRenderer = gameScene.getMapRenderer?.() ?? null;
            const citySearchLabelY = blockTopY - 70;
            const citySearchRowY = blockTopY - 40;

            this.add.text(
                buttonX,
                citySearchLabelY,
                'Take me to…',
                {
                    color: '#000000',
                    fontSize: '18px',
                    fontStyle: 'bold',
                    fontFamily: UI_FONT_FAMILY
                }
            ).setOrigin(0.5);

            this.cityDropDown?.destroy();
            if (mapRenderer) {
                this.cityDropDown = new CityListDropDown(this, mapRenderer);
                this.cityDropDown.setPosition(buttonX - 70, citySearchRowY);
                this.cityDropDown.init();
                this.add.existing(this.cityDropDown);
            }

            const goButton = this.add.rectangle(
                buttonX + 180,
                citySearchRowY,
                70,
                40,
                0x2563eb
            ).setInteractive({ useHandCursor: true });

            this.add.text(
                buttonX + 180,
                citySearchRowY,
                'Go',
                {
                    color: '#ffffff',
                    fontSize: '18px',
                    fontStyle: 'bold',
                    fontFamily: UI_FONT_FAMILY
                }
            ).setOrigin(0.5);

            const runCitySearch = () => {
                const selected = this.cityDropDown?.getSelectedCity() ?? null;
                if (!selected) return;
                this.centerGameCameraOnCity(selected, gameScene);
                this.closeSettings();
            };

            goButton.on('pointerdown', runCitySearch);

            bottomButtons.forEach((button, idx) => {
                const rect = this.add.rectangle(
                    buttonX,
                    yForButtonIndex(idx),
                    buttonWidth,
                    buttonHeight,
                    button.color
                ).setInteractive({ useHandCursor: true });

                this.add.text(
                    buttonX,
                    yForButtonIndex(idx),
                    button.label,
                    {
                        color: '#ffffff',
                        fontSize: '20px',
                        fontFamily: UI_FONT_FAMILY
                    }
                ).setOrigin(0.5);

                rect.on('pointerdown', button.onClick);
            });
        }
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
        // Critical: block clicks so they can't reach the tabs/buttons underneath.
        overlay.setInteractive();

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
            'Edit Player',
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
            'Save',
            {
                color: '#ffffff',
                fontSize: '20px'
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

        if (!this.isOwnPlayer(this.editingPlayer)) {
            this.showErrorMessage('You can only edit your own player');
            return;
        }

        try {
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/players/me`, {
                method: 'PATCH',
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    name: newName,
                    color: this.selectedColor || this.editingPlayer.color
                })
            });

            const responseData = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(responseData?.details || responseData?.error || 'Failed to update player');
            }

            // The server normalizes the name and color; show what it stored.
            const updatedPlayer: Player = {
                ...this.editingPlayer,
                name: responseData?.player?.name ?? newName,
                color: responseData?.player?.color ?? (this.selectedColor || this.editingPlayer.color)
            };

            // Update local state only after successful save
            const playerIndex = this.gameState.players.findIndex(p => p.id === this.editingPlayer!.id);
            if (playerIndex !== -1) {
                this.gameState.players[playerIndex] = updatedPlayer;
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
            const response = await authenticatedFetch(
                `${config.apiBaseUrl}/api/game/${this.gameState.id}/players/${player.id}`,
                { method: 'DELETE' }
            );

            const responseData = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(responseData?.details || responseData?.error || 'Failed to delete player');
            }

            // Update local state; the server says who the current player is now.
            const index = this.gameState.players.indexOf(player);
            if (index > -1) {
                this.gameState.players.splice(index, 1);
            }
            if (typeof responseData?.currentPlayerIndex === 'number') {
                this.gameState.currentPlayerIndex = responseData.currentPlayerIndex;
            } else if (this.gameState.currentPlayerIndex >= this.gameState.players.length) {
                this.gameState.currentPlayerIndex = 0;
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
        if (this.cityDropDown) {
            this.cityDropDown.destroy();
            this.cityDropDown = undefined;
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

    private centerGameCameraOnCity(city: CityListItem, gameScene: GameScene): void {
        // Prefer centering for predictable "jump to" behavior (no animation).
        gameScene.cameras.main.centerOn(city.x, city.y);
        gameScene.persistLocalCameraState();
    }

    private async endGame() {
        try {
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/game/${this.gameState.id}/end`, {
                method: 'POST'
            });

            if (!response.ok) {
                const responseData = await response.json().catch(() => null);
                throw new Error(responseData?.details || 'Failed to end game');
            }

            // Stop all current scenes
            this.scene.stop('GameScene');
            this.scene.stop('SettingsScene');

            // Clear persisted lobby "current game" state so /lobby doesn't auto-resume.
            // (Keys defined in lobby store; duplicated here to avoid importing React store into Phaser scene.)
            localStorage.removeItem('eurorails.currentGame');
            localStorage.removeItem('eurorails.currentPlayers');
            localStorage.removeItem('eurorails.gameTimestamp');

            // Return user to the lobby (do not show SetupScene / completion screens here).
            window.location.href = '/lobby';
        } catch (error) {
            console.error('Error ending game:', error);
            this.showErrorMessage(error instanceof Error ? error.message : 'Failed to end game');
        }
    }
} 
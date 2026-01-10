import 'phaser';
import { GameState } from '../../shared/types/GameTypes';
import { UI_FONT_FAMILY } from '../config/uiFont';

export class RulesScene extends Phaser.Scene {
    private gameState: GameState;

    constructor() {
        super({ key: 'RulesScene' });
        this.gameState = {
            id: '',
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
        // Add semi-transparent dark background
        const background = this.add.rectangle(
            0, 0,
            this.scale.width,
            this.scale.height,
            0x000000,
            0.7
        ).setOrigin(0).setInteractive();

        // Calculate panel dimensions
        const panelWidth = Math.min(800, this.scale.width - 40);
        const panelHeight = Math.min(600, this.scale.height - 40);

        // Add white background panel for rules
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
            panelTopY + 30,
            'Game Rules',
            {
                color: '#000000',
                fontSize: '32px',
                fontStyle: 'bold',
                fontFamily: UI_FONT_FAMILY
            }
        ).setOrigin(0.5);

        // Close button (top-right)
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

        closeBg.on('pointerdown', () => this.closeRules());

        // Rules content
        const rulesLeftX = panelLeftX + 30;
        const rulesWidth = panelWidth - 60;
        const rulesTopY = panelTopY + 80;

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
            "- Event cards take effect immediately; keep drawing until you have 3 Demand cards\n\n" +
            "Winning:\n" +
            "- Connect 7 major cities AND have ECU 250M in cash";

        this.add.text(
            rulesLeftX,
            rulesTopY,
            rulesText,
            {
                color: '#000000',
                fontSize: '15px',
                fontFamily: UI_FONT_FAMILY,
                wordWrap: { width: rulesWidth, useAdvancedWrap: true }
            }
        ).setOrigin(0, 0);
    }

    private closeRules(): void {
        this.scene.stop('RulesScene');
        this.scene.resume('GameScene');
    }
}

import 'phaser';

export class GameScene extends Phaser.Scene {
    private mapContainer!: Phaser.GameObjects.Container;
    private uiContainer!: Phaser.GameObjects.Container;
    private playerHandContainer!: Phaser.GameObjects.Container;

    constructor() {
        super({ key: 'GameScene' });
    }

    create() {
        // Create main containers for different parts of the UI
        this.createContainers();
        
        // Set up the game map area (main play area)
        this.setupMapArea();
        
        // Set up the UI overlay (leaderboard)
        this.setupUIOverlay();
        
        // Set up player's hand area (demand cards, train, money)
        this.setupPlayerHand();

        // Set up camera controls for the map
        this.setupCamera();
    }

    private createContainers() {
        // Main map container - will be scrollable
        this.mapContainer = this.add.container(0, 0);
        
        // UI overlay container - fixed position
        this.uiContainer = this.add.container(0, 0);
        
        // Player hand container - fixed at bottom
        this.playerHandContainer = this.add.container(0, this.cameras.main.height - 200);
        
        // Create a separate camera for UI elements that shouldn't scroll
        const uiCamera = this.cameras.add(0, 0, this.cameras.main.width, this.cameras.main.height);
        uiCamera.ignore(this.mapContainer);
        uiCamera.setScroll(0, 0);
        
        // Make main camera ignore UI elements
        this.cameras.main.ignore([this.uiContainer, this.playerHandContainer]);
    }

    private setupMapArea() {
        // Create a background for the map area
        const mapBackground = this.add.rectangle(0, 0, 3000, 2000, 0xf0f0f0);
        const mapLabel = this.add.text(
            10,
            10,
            'Game Map (Pan & Zoom)',
            { color: '#000000', fontSize: '16px' }
        );
        this.mapContainer.add([mapBackground, mapLabel]);
        
        // Add a grid overlay for development purposes
        this.createGrid();
    }

    private setupUIOverlay() {
        // Create semi-transparent background for leaderboard
        const leaderboardBg = this.add.rectangle(
            this.cameras.main.width - 200, 
            10, 
            190, 
            150, 
            0x000000, 
            0.3
        );
        
        // Add leaderboard title
        const leaderboardTitle = this.add.text(
            this.cameras.main.width - 190, 
            20, 
            'Leaderboard', 
            { color: '#ffffff', fontSize: '18px' }
        );
        
        // Add example player entry
        const player1Text = this.add.text(
            this.cameras.main.width - 180,
            50,
            'Player 1: ECU 50M',
            { color: '#ffffff', fontSize: '14px' }
        );
        
        this.uiContainer.add([leaderboardBg, leaderboardTitle, player1Text]);
    }

    private setupPlayerHand() {
        // Create background for player's hand area first
        const handBackground = this.add.rectangle(
            0,
            0,
            this.cameras.main.width,
            200,
            0x333333,
            0.8
        );
        this.playerHandContainer.add(handBackground);
        
        // Add sections for demand cards (3 slots)
        for (let i = 0; i < 3; i++) {
            // Create a container for each card slot to manage layering
            const cardContainer = this.add.container(50 + i * 160, 50);
            
            const cardSlot = this.add.rectangle(
                0,
                0,
                150,
                180,
                0x666666
            );
            
            const cardLabel = this.add.text(
                0,
                -20,
                `Demand Card ${i + 1}`,
                { color: '#ffffff', fontSize: '14px' }
            );
            cardLabel.setOrigin(0.5, 0);
            
            // Add elements to card container in correct order (background then text)
            cardContainer.add([cardSlot, cardLabel]);
            this.playerHandContainer.add(cardContainer);
        }
        
        // Create a container for train section to manage layering
        const trainContainer = this.add.container(530, 50);
        
        const trainSection = this.add.rectangle(
            0,
            0,
            200,
            180,
            0x666666
        );
        
        const trainLabel = this.add.text(
            0,
            -20,
            'Train Card',
            { color: '#ffffff', fontSize: '14px' }
        );
        trainLabel.setOrigin(0.5, 0);
        
        // Add elements to train container in correct order
        trainContainer.add([trainSection, trainLabel]);
        
        // Add money counter
        const moneyText = this.add.text(
            750,
            40,
            'Money: ECU 50M',
            { color: '#ffffff', fontSize: '20px' }
        );
        
        // Add containers to main player hand container
        this.playerHandContainer.add([trainContainer, moneyText]);
    }

    private setupCamera() {
        // Set up main camera to follow the map
        this.cameras.main.setBounds(0, 0, 3000, 2000);
        
        // Track if mouse is being dragged
        let isDragging = false;
        let lastPointerPosition = { x: 0, y: 0 };

        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            isDragging = true;
            lastPointerPosition = { x: pointer.x, y: pointer.y };
        });

        this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
            if (isDragging) {
                const deltaX = pointer.x - lastPointerPosition.x;
                const deltaY = pointer.y - lastPointerPosition.y;
                
                this.cameras.main.scrollX -= deltaX / this.cameras.main.zoom;
                this.cameras.main.scrollY -= deltaY / this.cameras.main.zoom;
                
                lastPointerPosition = { x: pointer.x, y: pointer.y };
            }
        });

        this.input.on('pointerup', () => {
            isDragging = false;
        });

        // Add zoom controls
        this.input.on('wheel', (pointer: Phaser.Input.Pointer, gameObjects: any, deltaX: number, deltaY: number) => {
            const zoom = this.cameras.main.zoom;
            if (deltaY > 0) {
                this.cameras.main.zoom = Math.max(0.5, zoom - 0.1);
            } else {
                this.cameras.main.zoom = Math.min(2, zoom + 0.1);
            }
        });
    }

    private createGrid() {
        const graphics = this.add.graphics();
        graphics.lineStyle(1, 0xcccccc, 0.3);

        // Create grid lines
        for (let x = 0; x < 3000; x += 100) {
            graphics.moveTo(x, 0);
            graphics.lineTo(x, 2000);
        }
        for (let y = 0; y < 2000; y += 100) {
            graphics.moveTo(0, y);
            graphics.lineTo(3000, y);
        }
        graphics.strokePath();

        this.mapContainer.add(graphics);
    }
} 
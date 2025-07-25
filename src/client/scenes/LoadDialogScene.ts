// src/client/scenes/LoadDialogScene.ts
import { Scene } from 'phaser';
import { CityData, Player, GameState } from '../../shared/types/GameTypes';
import { LoadService } from '../services/LoadService';
import { GameStateService } from '../services/GameStateService';
import { LoadType } from '../../shared/types/LoadTypes';
import { UIManager } from '../components/UIManager';

interface LoadDialogConfig {
    city: CityData;
    player: Player;
    gameState: GameState;
    onClose: () => void;
    onUpdateTrainCard: () => void;
    onUpdateHandDisplay: () => void;
    uiManager: UIManager;
}

interface LoadOperation {
    type: 'pickup' | 'delivery' | 'drop';
    loadType: LoadType;
    timestamp: number;
    id: string;
}

export class LoadDialogScene extends Scene {
    private city!: CityData;
    private player!: Player;
    private gameState!: GameState;
    private onClose!: () => void;
    private onUpdateTrainCard!: () => void;
    private onUpdateHandDisplay!: () => void;
    private uiManager!: UIManager;
    private loadService: LoadService;
    private gameStateService: GameStateService;
    private dialogContainer!: Phaser.GameObjects.Container;
    private loadOperations: LoadOperation[] = []; // Track operations this turn

    constructor() {
        super({ key: 'LoadDialogScene' });
        this.loadService = LoadService.getInstance();
        this.gameStateService = null!;
    }

    init(data: LoadDialogConfig) {
        this.city = data.city;
        this.player = data.player;
        this.gameState = data.gameState;
        this.gameStateService = new GameStateService(this.gameState);
        this.onClose = data.onClose;
        this.onUpdateTrainCard = data.onUpdateTrainCard;
        this.onUpdateHandDisplay = data.onUpdateHandDisplay;
        this.uiManager = data.uiManager;
    }

    async create() {
        try {
            // Ensure LoadService is initialized before proceeding
            await this.loadService.loadInitialState();
            console.log('LoadService initialized successfully');

            // Create a semi-transparent background overlay
            const overlay = this.add.rectangle(
                0, 0,
                this.cameras.main.width,
                this.cameras.main.height,
                0x000000, 0.7
            ).setOrigin(0);

            // Make overlay interactive to prevent clicking through
            overlay.setInteractive();

            // Create the dialog container
            this.dialogContainer = this.add.container(
                this.cameras.main.centerX,
                this.cameras.main.centerY
            );

            // Create dialog background - make it wider and taller
            const dialogBg = this.add.rectangle(
                0, 0, 700, 400, 0x333333, 0.95  // Increased width from 500 to 700
            ).setOrigin(0.5);

            // Add title
            const title = this.add.text(
                0, -170,  // Moved up to make room for operations section
                `${this.city.name} - Load Operations`,
                {
                    color: "#ffffff",
                    fontSize: "24px",
                    fontStyle: "bold"
                }
            ).setOrigin(0.5);

            // Add close button
            const closeButton = this.createCloseButton();

            this.dialogContainer.add([dialogBg, title, closeButton]);

            // Add available loads section
            await this.createLoadSections();
            
            // Initialize the operations section
            this.refreshLoadOperationsUI();
        } catch (error) {
            console.error('Error in LoadDialogScene create:', error);
            // Handle the error appropriately - maybe show an error message to the user
            this.onClose();
        }
    }

    private createCloseButton() {
        const container = this.add.container(330, -170);  // Adjusted x position from 230 to 330

        const button = this.add.rectangle(0, 0, 30, 30, 0x666666)
            .setInteractive({ useHandCursor: true });

        const text = this.add.text(0, 0, "×", {
            color: "#ffffff",
            fontSize: "24px"
        }).setOrigin(0.5);

        button.on('pointerdown', () => {
            this.closeDialog();
        });

        container.add([button, text]);
        return container;
    }

    private async createLoadSections() {
        console.log('Creating load sections for city:', this.city.name);
        const sectionsContainer = this.add.container(0, 0);
        this.dialogContainer.add(sectionsContainer);
        sectionsContainer.setName('sectionsContainer');
        
        await this.createPickupSection(sectionsContainer);
        await this.createDeliverySection(sectionsContainer);
        await this.createDropSection(sectionsContainer);
    }

    private async createPickupSection(container: Phaser.GameObjects.Container) {
        console.log('Creating pickup section...');
        const cityLoadDetails = await this.loadService.getCityLoadDetails(this.city.name);
        console.log('City load details for pickup:', cityLoadDetails);
        
        if (cityLoadDetails.length > 0) {
            const title = this.add.text(-300, -100, "Available for Pickup:", {
                color: "#ffffff",
                fontSize: "18px"
            });
            
            container.add(title);
            
            cityLoadDetails.forEach((load, index) => {
                const button = this.createLoadButton(
                    -300,
                    -60 + (index * 50),
                    load.loadType,
                    load.count,
                    () => this.handleLoadPickup(load.loadType)
                );
                container.add(button);
            });
        }
    }

    private async createDeliverySection(container: Phaser.GameObjects.Container) {
        console.log('Creating delivery section...');
        const cityLoadDetails = await this.loadService.getCityLoadDetails(this.city.name);
        console.log('City load details for delivery:', cityLoadDetails);
        
        // Get deliverable loads (loads on train that have a demand card for this city)
        const deliverableLoads = this.getDeliverableLoads(this.player.trainState.loads || []);
        console.log('Deliverable loads:', deliverableLoads);
        
        if (deliverableLoads.length > 0) {
            const title = this.add.text(-50, -100, "Can be Delivered:", {
                color: "#ffffff",
                fontSize: "18px"
            });
            
            container.add(title);
            
            deliverableLoads.forEach((load, index) => {
                const button = this.createLoadButton(
                    -50,
                    -60 + (index * 50),
                    load.type,
                    1,
                    () => this.handleLoadDelivery(load)
                );
                container.add(button);
            });
        }
    }

    private async createDropSection(container: Phaser.GameObjects.Container) {
        console.log('Creating drop section...');
        const cityLoadDetails = await this.loadService.getCityLoadDetails(this.city.name);
        console.log('City load details for drop:', cityLoadDetails);
        
        // Get droppable loads (all loads currently on the train)
        const droppableLoads = this.player.trainState.loads || [];
        console.log('Droppable loads:', droppableLoads);
        
        if (droppableLoads.length > 0) {
            const title = this.add.text(150, -100, "Drop Loads:", {
                color: "#ffffff",
                fontSize: "18px"
            });
            
            container.add(title);
            
            droppableLoads.forEach((load, index) => {
                const button = this.createLoadButton(
                    150,
                    -60 + (index * 50),
                    load,
                    1,
                    () => this.handleLoadDrop(load)
                );
                container.add(button);
            });
        }
    }

    private createLoadButton(
        x: number,
        y: number,
        loadType: LoadType,
        count: number,
        callback: () => void
    ): Phaser.GameObjects.Container {
        const container = this.add.container(x, y);

        const button = this.add.rectangle(0, 0, 180, 40, 0x444444)
            .setOrigin(0)
            .setInteractive({ useHandCursor: true });

        const text = this.add.text(10, 10, `${loadType} (${count})`, {
            color: "#ffffff",
            fontSize: "16px"
        });

        button.on("pointerdown", callback);
        button.on("pointerover", () => button.setFillStyle(0x555555));
        button.on("pointerout", () => button.setFillStyle(0x444444));

        container.add([button, text]);
        return container;
    }

    private getDeliverableLoads(currentLoads: LoadType[]): Array<{type: LoadType, payment: number, cardId: number}> {
        if (!this.player.hand) return [];
        
        // Flatten all demands from all cards that match the current city
        const allPossibleDeliveries = this.player.hand.flatMap(card => 
            card.demands
                .filter(demand => demand.city === this.city.name)
                .filter(demand => currentLoads.includes(demand.resource))
                .map(demand => ({
                    type: demand.resource,
                    payment: demand.payment,
                    cardId: card.id  // Track which card this demand came from
                }))
        );

        // Remove duplicates but keep highest payment if same resource demanded by multiple cards
        const deliveryMap = new Map<LoadType, {type: LoadType, payment: number, cardId: number}>();
        allPossibleDeliveries.forEach(delivery => {
            const existing = deliveryMap.get(delivery.type);
            if (!existing || existing.payment < delivery.payment) {
                deliveryMap.set(delivery.type, delivery);
            }
        });
        
        return Array.from(deliveryMap.values());
    }

    private async handleLoadPickup(loadType: LoadType) {
        try {
            if (!this.gameStateService) {
                console.error('GameStateService not initialized');
                return;
            }

            if (!this.player.trainState.loads) {
                this.player.trainState.loads = [];
            }
            
            // Calculate train capacity
            const maxCapacity = this.player.trainType === "Heavy Freight" || 
                              this.player.trainType === "Superfreight" ? 3 : 2;
                              
            // Check if train has space
            if (this.player.trainState.loads.length >= maxCapacity) {
                console.error('Train is at maximum capacity');
                return;
            }
            
            // Try to pick up the load from the city
            const pickupSuccess = await this.loadService.pickupLoad(loadType, this.city.name);
            if (!pickupSuccess) {
                console.error('Failed to pick up load from city');
                return;
            }

            // Add load to train
            this.player.trainState.loads.push(loadType);
            
            // Track this operation with unique ID
            this.loadOperations.push({
                type: 'pickup',
                loadType,
                timestamp: Date.now(),
                id: `${Date.now()}-${Math.random()}`
            });
            
            // Update game state
            const success = await this.gameStateService.updatePlayerLoads(
                this.player.id,
                this.player.trainState.loads
            );

            if (success) {
                // Update displays
                this.onUpdateTrainCard();
                
                // Update just the load sections container
                const sectionsContainer = this.dialogContainer.getByName('sectionsContainer');
                if (sectionsContainer) {
                    sectionsContainer.destroy();
                }
                this.createLoadSections();
                
                // Update operations UI
                this.refreshLoadOperationsUI();
            } else {
                // If update failed, revert all changes
                await this.loadService.returnLoad(loadType);
                this.player.trainState.loads.pop();
                this.loadOperations.pop();
                this.refreshLoadOperationsUI();
                console.error('Failed to update player loads in game state');
            }
        } catch (error) {
            console.error('Failed to pickup load:', error);
            // Revert changes on error
            if (this.player.trainState.loads) {
                this.player.trainState.loads.pop();
                await this.loadService.returnLoad(loadType);
            }
            this.loadOperations.pop();
            this.refreshLoadOperationsUI();
        }
    }

    private async handleLoadDelivery(load: {type: LoadType, payment: number, cardId: number}) {
        try {
            if (!this.player.trainState.loads) {
                console.error('No loads found on train');
                return;
            }
            
            // Remove load from train
            this.player.trainState.loads = this.player.trainState.loads.filter(
                l => l !== load.type
            );
            
            // Add payment
            const newMoney = this.player.money + load.payment;
            
            try {
                // Return the load to global availability
                await this.loadService.returnLoad(load.type);

                // Update all game state in parallel
                const [loadsUpdated, moneyUpdated, cardFulfilled] = await Promise.all([
                    this.gameStateService.updatePlayerLoads(
                        this.player.id,
                        this.player.trainState.loads
                    ),
                    this.gameStateService.updatePlayerMoney(
                        this.player.id,
                        newMoney
                    ),
                    this.gameStateService.fulfillDemandCard(
                        this.player.id,
                        this.city.name,
                        load.type,
                        load.cardId
                    )
                ]);

                if (!loadsUpdated || !moneyUpdated || !cardFulfilled) {
                    throw new Error('Failed to update game state');
                }
                
                // Track this operation
                this.loadOperations.push({
                    type: 'delivery',
                    loadType: load.type,
                    timestamp: Date.now(),
                    id: `${Date.now()}-${Math.random()}`
                });
                
                // Update displays
                this.onUpdateTrainCard();
                this.onUpdateHandDisplay();
                this.uiManager.setupUIOverlay();
                
                // Close dialog after successful delivery
                this.closeDialog();
            } catch (error) {
                console.error('Failed to update game state:', error);
                // Revert changes on error
                this.player.trainState.loads.push(load.type);
                await this.loadService.pickupLoad(load.type, this.city.name);
                throw error;
            }
        } catch (error) {
            console.error('Failed to deliver load:', error);
            // Show error message to user using Phaser's add.text
            const errorText = new Phaser.GameObjects.Text(
                this,
                0, 0,
                'Failed to deliver load. Please try again.',
                {
                    color: '#ff0000',
                    fontSize: '16px'
                }
            ).setOrigin(0.5);
            
            this.dialogContainer.add(errorText);
            
            // Remove error message after 3 seconds using Phaser's time events
            this.time.addEvent({
                delay: 3000,
                callback: () => {
                    errorText.destroy();
                }
            });
        }
    }

    private async handleLoadDrop(loadType: LoadType) {
        try {
            if (!this.player.trainState.loads) {
                console.error('No loads found on train');
                return;
            }
            
            // Remove load from train
            this.player.trainState.loads = this.player.trainState.loads.filter(
                l => l !== loadType
            );
            
            try {
                // Return the load to the city's available loads if the city produces this load type
                const availableLoads = await this.loadService.getCityLoadDetails(this.city.name);
                const cityProducesLoad = availableLoads.some(l => l.loadType === loadType);
                
                if (cityProducesLoad) {
                    await this.loadService.returnLoad(loadType);
                } else {
                    // If city doesn't produce this load, it stays in the city
                    // and any existing load of the same type goes back to the tray
                    await this.loadService.setLoadInCity(this.city.name, loadType);
                }

                // Update game state with new train loads
                await this.gameStateService.updatePlayerLoads(
                    this.player.id,
                    this.player.trainState.loads
                );
                
                // Track this operation with unique ID
                this.loadOperations.push({
                    type: 'drop',
                    loadType,
                    timestamp: Date.now(),
                    id: `${Date.now()}-${Math.random()}`
                });
                
                // Update displays
                this.onUpdateTrainCard();
                
                // Update just the load sections container
                const sectionsContainer = this.dialogContainer.getByName('sectionsContainer');
                if (sectionsContainer) {
                    sectionsContainer.destroy();
                }
                this.createLoadSections();
                
                // Update operations UI
                this.refreshLoadOperationsUI();
            } catch (error) {
                // Revert changes on error
                console.error('Failed to update game state:', error);
                // Restore the load to the train
                this.player.trainState.loads.push(loadType);
            }
        } catch (error) {
            console.error('Failed to drop load:', error);
        }
    }

    private async undoLoadOperation(operation: LoadOperation) {
        try {
            if (!this.player.trainState.loads) return;

            if (operation.type === 'pickup') {
                // Find the index of this specific load in the train's loads
                const loadIndex = this.player.trainState.loads.lastIndexOf(operation.loadType);
                if (loadIndex === -1) return;

                // Remove only this specific instance of the load
                this.player.trainState.loads.splice(loadIndex, 1);

                // Return the load to the city
                await this.loadService.returnLoad(operation.loadType);

                // Remove only this specific operation from tracking
                this.loadOperations = this.loadOperations.filter(
                    op => op.id !== operation.id
                );

                // Update game state
                await this.gameStateService.updatePlayerLoads(
                    this.player.id,
                    this.player.trainState.loads
                );

                // Update the train card display
                this.onUpdateTrainCard();

                // Refresh the UI
                this.refreshLoadOperationsUI();
            } else if (operation.type === 'drop') {
                // Try to pick the load back up from the city
                const availableLoads = await this.loadService.getCityLoadDetails(this.city.name);
                const loadAvailable = availableLoads.some(l => l.loadType === operation.loadType);
                
                if (loadAvailable) {
                    // Add load back to train
                    this.player.trainState.loads.push(operation.loadType);
                    
                    // Remove only this specific operation from tracking
                    this.loadOperations = this.loadOperations.filter(
                        op => op.id !== operation.id
                    );

                    // Update game state
                    await this.gameStateService.updatePlayerLoads(
                        this.player.id,
                        this.player.trainState.loads
                    );

                    // Update displays
                    this.onUpdateTrainCard();
                    this.refreshLoadOperationsUI();
                }
            }
        } catch (error) {
            console.error('Failed to undo load operation:', error);
        }
    }

    private refreshLoadOperationsUI() {
        // Remove existing operations UI if any
        const existingOps = this.dialogContainer.getAll('name', 'operationsSection');
        existingOps.forEach(op => op.destroy());

        // Create new operations section
        const operationsSection = this.add.container(0, 100);
        operationsSection.setName('operationsSection');

        // Add title for operations this turn
        if (this.loadOperations.length > 0) {
            const title = this.add.text(0, 0, "Operations this turn:", {
                color: "#ffffff",
                fontSize: "18px"
            });
            operationsSection.add(title);

            // Add each operation with undo button
            this.loadOperations.forEach((operation, index) => {
                const opContainer = this.add.container(0, 40 + index * 40);
                
                const text = this.add.text(0, 0, 
                    `${operation.type === 'pickup' ? 'Picked up' : operation.type === 'drop' ? 'Dropped' : 'Delivered'} ${operation.loadType}`, 
                    { color: "#ffffff", fontSize: "16px" }
                );

                const undoButton = this.add.rectangle(200, 0, 60, 30, 0x666666)
                    .setInteractive({ useHandCursor: true });
                
                const undoText = this.add.text(200, 0, "Undo", {
                    color: "#ffffff",
                    fontSize: "14px"
                }).setOrigin(0.5);

                undoButton.on('pointerdown', () => this.undoLoadOperation(operation));
                undoButton.on('pointerover', () => undoButton.setFillStyle(0x777777));
                undoButton.on('pointerout', () => undoButton.setFillStyle(0x666666));

                opContainer.add([text, undoButton, undoText]);
                operationsSection.add(opContainer);
            });
        }

        this.dialogContainer.add(operationsSection);
    }

    private closeDialog() {
        // Clear operations tracking when dialog closes
        this.loadOperations = [];
        this.onUpdateTrainCard();
        this.onClose();
    }
}
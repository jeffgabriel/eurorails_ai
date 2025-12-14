// src/client/scenes/LoadDialogScene.ts
import { Scene } from 'phaser';
import { CityData, Player, GameState, TRAIN_PROPERTIES } from '../../shared/types/GameTypes';
import { LoadService } from '../services/LoadService';
import { GameStateService } from '../services/GameStateService';
import { PlayerStateService } from '../services/PlayerStateService';
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
    private playerStateService: PlayerStateService;
    private dialogContainer!: Phaser.GameObjects.Container;
    private loadOperations: LoadOperation[] = []; // Track operations this turn

    constructor() {
        super({ key: 'LoadDialogScene' });
        this.loadService = LoadService.getInstance();
    }

    init(data: LoadDialogConfig) {
        this.city = data.city;
        this.player = data.player;
        this.gameState = data.gameState;
        this.gameStateService = new GameStateService(this.gameState);
        this.playerStateService = new PlayerStateService();
        
        // Initialize player state service for local player
        this.playerStateService.initializeLocalPlayer(this.gameState.players);
        
        // Assert that the passed player is the local player (for security)
        const localPlayer = this.playerStateService.getLocalPlayer();
        if (!localPlayer) {
            console.error('Cannot initialize LoadDialogScene: no local player identified');
            return;
        }
        if (localPlayer.id !== data.player.id) {
            console.error(`Player mismatch: LoadDialogScene was passed player ${data.player.name} (${data.player.id}) but local player is ${localPlayer.name} (${localPlayer.id})`);
        }
        
        this.onClose = data.onClose;
        this.onUpdateTrainCard = data.onUpdateTrainCard;
        this.onUpdateHandDisplay = data.onUpdateHandDisplay;
        this.uiManager = data.uiManager;
    }

    async create() {
        try {
            // Ensure LoadService is initialized before proceeding
            await this.loadService.loadInitialState();

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
        const sectionsContainer = this.add.container(0, 0);
        this.dialogContainer.add(sectionsContainer);
        sectionsContainer.setName('sectionsContainer');
        
        await this.createPickupSection(sectionsContainer);
        await this.createDeliverySection(sectionsContainer);
        await this.createDropSection(sectionsContainer);
    }

    private async createPickupSection(container: Phaser.GameObjects.Container) {
        const cityLoadDetails = await this.loadService.getCityLoadDetails(this.city.name);
        
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
        const cityLoadDetails = await this.loadService.getCityLoadDetails(this.city.name);
        
        // Get deliverable loads (loads on train that have a demand card for this city)
        const deliverableLoads = this.getDeliverableLoads(this.player.trainState.loads || []);
        
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
        const cityLoadDetails = await this.loadService.getCityLoadDetails(this.city.name);
        
        // Get droppable loads (all loads currently on the train)
        const droppableLoads = this.player.trainState.loads || [];
        
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
            
            // Calculate train capacity using TRAIN_PROPERTIES
            const maxCapacity = TRAIN_PROPERTIES[this.player.trainType].capacity;
                              
            // Check if train has space
            if (this.player.trainState.loads.length >= maxCapacity) {
                console.error('Train is at maximum capacity');
                return;
            }
            
            // Server-authoritative: Make API calls first
            // Try to pick up the load from the city
            const pickupSuccess = await this.loadService.pickupLoad(loadType, this.city.name);
            if (!pickupSuccess) {
                console.error('Failed to pick up load from city');
                return;
            }

            // Calculate new loads array (for API call, not for local state yet)
            const updatedLoads = [...this.player.trainState.loads, loadType];
            
            // Update game state via API
            const success = await this.playerStateService.updatePlayerLoads(
                updatedLoads,
                this.gameState.id
            );

            if (!success) {
                // If update failed, revert load pickup
                await this.loadService.returnLoad(loadType);
                console.error('Failed to update player loads in game state');
                return;
            }

            // Only update local state after all API calls succeed
            this.player.trainState.loads = updatedLoads;
            
            // Track this operation with unique ID
            this.loadOperations.push({
                type: 'pickup',
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
            console.error('Failed to pickup load:', error);
            // Show error - no need to revert since we never updated local state
            this.refreshLoadOperationsUI();
        }
    }

    private async handleLoadDelivery(load: {type: LoadType, payment: number, cardId: number}) {
        // Store original state for rollback if needed
        const originalLoads = [...(this.player.trainState.loads || [])];
        const originalMoney = this.player.money;
        
        try {
            if (!this.player.trainState.loads) {
                console.error('No loads found on train');
                return;
            }
            
            // Calculate new state values (for API calls only, not for local state)
            // Remove only one instance of the load type (not all instances)
            const loadIndex = this.player.trainState.loads.indexOf(load.type);
            const updatedLoads = [...this.player.trainState.loads];
            if (loadIndex !== -1) {
                updatedLoads.splice(loadIndex, 1);
            }
            const newMoney = this.player.money + load.payment;
            
            // Server-authoritative pattern: Make all API calls first
            // Return the load to global availability
            await this.loadService.returnLoad(load.type);

            // Update all game state in parallel
            const [loadsUpdated, moneyUpdated, cardFulfilled] = await Promise.all([
                this.playerStateService.updatePlayerLoads(
                    updatedLoads,
                    this.gameState.id
                ),
                this.playerStateService.updatePlayerMoney(
                    newMoney,
                    this.gameState.id
                ),
                this.playerStateService.fulfillDemandCard(
                    this.city.name,
                    load.type,
                    load.cardId,
                    this.gameState.id
                )
            ]);

            if (!loadsUpdated || !moneyUpdated || !cardFulfilled) {
                // Rollback any state changes that may have occurred in PlayerStateService
                // (PlayerStateService updates this.localPlayer which is a reference to gameState.players)
                const localPlayer = this.playerStateService.getLocalPlayer();
                if (localPlayer) {
                    if (!loadsUpdated) {
                        localPlayer.trainState.loads = originalLoads;
                    }
                    if (!moneyUpdated) {
                        localPlayer.money = originalMoney;
                    }
                    // Note: fulfillDemandCard updates hand, but we can't easily rollback that
                    // without storing the original hand. The card will be re-drawn on next turn.
                }
                throw new Error('Failed to update game state');
            }
            
            // All API calls succeeded - state is already updated by PlayerStateService
            // (since it updates this.localPlayer which is a reference to this.player)
            // Just refresh the UI
            
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
            console.error('Failed to deliver load:', error);
            
            // Rollback state changes that may have occurred in PlayerStateService
            const localPlayer = this.playerStateService.getLocalPlayer();
            if (localPlayer) {
                // Revert loads and money to original values
                localPlayer.trainState.loads = originalLoads;
                localPlayer.money = originalMoney;
            }
            
            // Show error message to user
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
            
            // Refresh UI to show reverted state
            this.onUpdateTrainCard();
            this.onUpdateHandDisplay();
        }
    }

    private async handleLoadDrop(loadType: LoadType) {
        try {
            if (!this.player.trainState.loads) {
                console.error('No loads found on train');
                return;
            }
            
            // Calculate new loads array (for API call, not for local state yet)
            // Remove only one instance of the load type (not all instances)
            const index = this.player.trainState.loads.indexOf(loadType);
            if (index === -1) return;
            const updatedLoads = [...this.player.trainState.loads];
            updatedLoads.splice(index, 1);
            
            // Server-authoritative: Make API calls first
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
            const success = await this.playerStateService.updatePlayerLoads(
                updatedLoads,
                this.gameState.id
            );

            if (!success) {
                console.error('Failed to update game state');
                return;
            }

            // Only update local state after all API calls succeed
            this.player.trainState.loads = updatedLoads;
                
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
            console.error('Failed to drop load:', error);
            // Show error - no need to revert since we never updated local state
        }
    }

    private async undoLoadOperation(operation: LoadOperation) {
        try {
            if (!this.player.trainState.loads) return;

            if (operation.type === 'pickup') {
                // Find the index of this specific load in the train's loads
                const loadIndex = this.player.trainState.loads.lastIndexOf(operation.loadType);
                if (loadIndex === -1) return;

                // Calculate new loads array (for API call, not for local state yet)
                const updatedLoads = [...this.player.trainState.loads];
                updatedLoads.splice(loadIndex, 1);

                // Server-authoritative: Make API calls first
                // Return the load to the city
                await this.loadService.returnLoad(operation.loadType);

                // Update game state
                const success = await this.playerStateService.updatePlayerLoads(
                    updatedLoads,
                    this.gameState.id
                );

                if (!success) {
                    console.error('Failed to update game state');
                    return;
                }

                // Only update local state after all API calls succeed
                this.player.trainState.loads = updatedLoads;

                // Remove only this specific operation from tracking
                this.loadOperations = this.loadOperations.filter(
                    op => op.id !== operation.id
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
                    // Calculate new loads array (for API call, not for local state yet)
                    const updatedLoads = [...this.player.trainState.loads, operation.loadType];
                    
                    // Server-authoritative: Make API calls first
                    const pickupSuccess = await this.loadService.pickupLoad(operation.loadType, this.city.name);
                    if (!pickupSuccess) {
                        console.error('Failed to pick up load');
                        return;
                    }

                    // Update game state
                    const success = await this.playerStateService.updatePlayerLoads(
                        updatedLoads,
                        this.gameState.id
                    );

                    if (!success) {
                        // Revert pickup if update failed
                        await this.loadService.returnLoad(operation.loadType);
                        console.error('Failed to update game state');
                        return;
                    }

                    // Only update local state after all API calls succeed
                    this.player.trainState.loads = updatedLoads;
                    
                    // Remove only this specific operation from tracking
                    this.loadOperations = this.loadOperations.filter(
                        op => op.id !== operation.id
                    );

                    // Update displays
                    this.onUpdateTrainCard();
                    this.refreshLoadOperationsUI();
                }
            }
        } catch (error) {
            console.error('Failed to undo load operation:', error);
            // Show error - no need to revert since we never updated local state
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
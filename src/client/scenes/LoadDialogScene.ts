// src/client/scenes/LoadDialogScene.ts
import { Scene } from 'phaser';
import { CityData, Player, GameState, TRAIN_PROPERTIES } from '../../shared/types/GameTypes';
import { LoadService } from '../services/LoadService';
import { GameStateService } from '../services/GameStateService';
import { PlayerStateService } from '../services/PlayerStateService';
import { LoadType } from '../../shared/types/LoadTypes';
import { UIManager } from '../components/UIManager';
import { TurnActionManager } from '../components/TurnActionManager';

interface LoadDialogConfig {
    city: CityData;
    player: Player;
    gameState: GameState;
    playerStateService: PlayerStateService;
    onClose: () => void;
    onUpdateTrainCard: () => void;
    onUpdateHandDisplay: () => void;
    uiManager: UIManager;
    turnActionManager?: TurnActionManager | null;
}

export class LoadDialogScene extends Scene {
    private city!: CityData;
    private player!: Player;
    private gameState!: GameState;
    private onClose!: () => void;
    private onUpdateTrainCard!: () => void;
    private onUpdateHandDisplay!: () => void;
    private uiManager!: UIManager;
    private turnActionManager: TurnActionManager | null = null;
    private loadService: LoadService;
    private gameStateService: GameStateService;
    private playerStateService: PlayerStateService;
    private dialogContainer!: Phaser.GameObjects.Container;
    private errorText: Phaser.GameObjects.Text | null = null;

    constructor() {
        super({ key: 'LoadDialogScene' });
        this.loadService = LoadService.getInstance();
    }

    init(data: LoadDialogConfig) {
        this.city = data.city;
        this.player = data.player;
        this.gameState = data.gameState;
        this.gameStateService = new GameStateService(this.gameState);
        this.playerStateService = data.playerStateService;
        
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
        this.turnActionManager = data.turnActionManager || null;
    }

    async create() {
        try {
            // Ensure LoadService is initialized before proceeding
            await this.loadService.loadInitialState();

            // Keep input focused on this scene while open
            this.input.setTopOnly(true);

            // Create a semi-transparent background overlay
            const overlay = this.add.rectangle(
                0, 0,
                this.scale.width,
                this.scale.height,
                0x000000, 0.88
            ).setOrigin(0);
            overlay.setScrollFactor(0);
            overlay.setDepth(10000);

            // Make overlay interactive to prevent clicking through
            overlay.setInteractive({ useHandCursor: true });
            overlay.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
                // Swallow clicks so they don't reach the board.
                if (pointer.event) {
                    pointer.event.stopPropagation();
                }
            });

            // Create the dialog container
            this.dialogContainer = this.add.container(
                this.cameras.main.centerX,
                this.cameras.main.centerY
            );
            this.dialogContainer.setDepth(10001);

            // Create dialog background - make it wider and taller
            const dialogBg = this.add.rectangle(
                0, 0, 700, 420, 0x222222, 1.0  // Slightly taller + fully opaque
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

    private showError(message: string): void {
        try {
            if (this.errorText) {
                this.errorText.destroy();
                this.errorText = null;
            }
            this.errorText = this.add.text(0, 165, message, {
                color: "#ff6666",
                fontSize: "16px",
                fontStyle: "bold",
                wordWrap: { width: 640, useAdvancedWrap: true },
                align: "center",
            }).setOrigin(0.5);
            this.dialogContainer.add(this.errorText);
            this.time.addEvent({
                delay: 2500,
                callback: () => {
                    this.errorText?.destroy();
                    this.errorText = null;
                }
            });
        } catch (e) {
            console.error("Failed to show error:", e);
        }
    }

    private getTrainCapacitySafe(): number {
        const props = (TRAIN_PROPERTIES as any)[this.player.trainType];
        if (props && typeof props.capacity === 'number') {
            return props.capacity;
        }
        // Defensive fallback: Freight capacity
        console.warn(`Unknown trainType "${String(this.player.trainType)}" in LoadDialogScene; defaulting capacity=2`);
        return 2;
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
            const maxCapacity = this.getTrainCapacitySafe();
                              
            // Check if train has space
            if (this.player.trainState.loads.length >= maxCapacity) {
                this.showError('Train is at maximum capacity');
                return;
            }
            
            // Server-authoritative: Make API calls first
            // Try to pick up the load from the city
            const pickupSuccess = await this.loadService.pickupLoad(loadType, this.city.name, this.gameState.id);
            if (!pickupSuccess) {
                this.showError('Could not pick up that load (not available or server rejected).');
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
                await this.loadService.returnLoad(loadType, this.gameState.id, this.city.name);
                this.showError('Failed to update your train loads. Please try again.');
                return;
            }

            // Only update local state after all API calls succeed
            this.player.trainState.loads = updatedLoads;
            this.turnActionManager?.recordLoadPickup(this.city.name, loadType);
            
            // Update displays
            this.onUpdateTrainCard();
            this.onUpdateHandDisplay();
            
            // Update just the load sections container
            const sectionsContainer = this.dialogContainer.getByName('sectionsContainer');
            if (sectionsContainer) {
                sectionsContainer.destroy();
            }
            this.createLoadSections();
            
        } catch (error) {
            console.error('Failed to pickup load:', error);
            // Show error - no need to revert since we never updated local state
            this.showError('Pickup failed. Check console for details.');
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

            // Server-authoritative pattern: Make all API calls first
            // Return the load to global availability
            await this.loadService.returnLoad(load.type, this.gameState.id, this.city.name);

            const delivered = await this.playerStateService.deliverLoad(
                this.city.name,
                load.type,
                load.cardId,
                this.gameState.id
            );

            if (!delivered) {
                // Best-effort compensation: re-pickup the load so the global pool doesn't drift
                try {
                    await this.loadService.pickupLoad(load.type, this.city.name, this.gameState.id);
                } catch {
                    // ignore
                }
                throw new Error('Failed to deliver load');
            }
            
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/ee63971d-7078-4c66-a767-c90c475dbcfc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'hand-bug-pre',hypothesisId:'H18',location:'LoadDialogScene.ts:handleLoadDelivery',message:'after deliverLoad',data:{playerId:this.player?.id,localPlayerId:this.playerStateService.getLocalPlayerId?.(),sameRef:this.player===this.playerStateService.getLocalPlayer(),dialogHandIds:Array.isArray(this.player?.hand)?this.player.hand.map((c:any)=>c?.id).filter((v:any)=>typeof v==="number"):[],serviceHandIds:Array.isArray(this.playerStateService.getLocalPlayer()?.hand)?this.playerStateService.getLocalPlayer()!.hand.map((c:any)=>c?.id).filter((v:any)=>typeof v==="number"):[]},timestamp:Date.now()})}).catch(()=>{});
            // #endregion agent log

            // All API calls succeeded - state is already updated by PlayerStateService
            // (since it updates this.localPlayer which is a reference to this.player)
            // Just refresh the UI
            this.turnActionManager?.recordLoadDelivery({
                city: this.city.name,
                loadType: load.type,
                cardIdUsed: load.cardId,
                newCardIdDrawn: delivered.newCardId,
                payment: delivered.payment
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
                await this.loadService.returnLoad(loadType, this.gameState.id, this.city.name);
            } else {
                // If city doesn't produce this load, it stays in the city
                // and any existing load of the same type goes back to the tray
                await this.loadService.setLoadInCity(this.city.name, loadType, this.gameState.id);
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
            this.turnActionManager?.recordLoadDrop(this.city.name, loadType);
            
            // Update displays
            this.onUpdateTrainCard();
            this.onUpdateHandDisplay();
            
            // Update just the load sections container
            const sectionsContainer = this.dialogContainer.getByName('sectionsContainer');
            if (sectionsContainer) {
                sectionsContainer.destroy();
            }
            this.createLoadSections();
            
        } catch (error) {
            console.error('Failed to drop load:', error);
            // Show error - no need to revert since we never updated local state
        }
    }


    private closeDialog() {
        this.onUpdateTrainCard();
        this.onClose();
    }
}
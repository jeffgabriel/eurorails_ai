// src/client/scenes/LoadDialogScene.ts
import { Scene } from 'phaser';
import { CityData, Player, GameState } from '../../shared/types/GameTypes';
import { LoadService } from '../services/LoadService';
import { GameStateService } from '../services/GameStateService';
import { LoadType } from '@/shared/types/LoadTypes';

interface LoadDialogConfig {
    city: CityData;
    player: Player;
    gameState: GameState;
    onClose: () => void;
}

export class LoadDialogScene extends Scene {
    private city!: CityData;
    private player!: Player;
    private gameState!: GameState;
    private onClose!: () => void;
    private loadService: LoadService;
    private gameStateService: GameStateService;
    private dialogContainer!: Phaser.GameObjects.Container;

    constructor() {
        super({ key: 'LoadDialogScene' });
        this.loadService = LoadService.getInstance();
        this.gameStateService = new GameStateService(this.gameState);
    }

    init(data: LoadDialogConfig) {
        this.city = data.city;
        this.player = data.player;
        this.gameState = data.gameState;
        this.onClose = data.onClose;
    }

    create() {
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

        // Create dialog background
        const dialogBg = this.add.rectangle(
            0, 0, 400, 300, 0x333333, 0.95
        ).setOrigin(0.5);

        // Add title
        const title = this.add.text(
            0, -130,
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
        this.createLoadSections();
    }

    private createCloseButton() {
        const container = this.add.container(180, -130);

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
        // Get available loads at this city
        const availableLoads = await this.loadService.getCityLoadDetails(this.city.name);

        // Calculate train capacity
        const maxCapacity = this.player.trainType === "Heavy Freight" || 
                          this.player.trainType === "Superfreight" ? 3 : 2;
        const currentLoads = this.player.trainState.loads || [];
        const hasSpace = currentLoads.length < maxCapacity;

        // Create sections container
        const sectionsContainer = this.add.container(-180, -80);

        // Show available loads if train has space
        if (hasSpace) {
            this.createPickupSection(sectionsContainer, availableLoads);
        }

        // Show deliverable loads
        this.createDeliverySection(sectionsContainer, currentLoads);

        this.dialogContainer.add(sectionsContainer);
    }

    private createPickupSection(
        container: Phaser.GameObjects.Container,
        availableLoads: Array<{ loadType: LoadType; count: number }>
    ) {
        const title = this.add.text(0, 0, "Available for Pickup:", {
            color: "#ffffff",
            fontSize: "18px"
        });
        container.add(title);

        availableLoads.forEach((load, index) => {
            const button = this.createLoadButton(
                0, 40 + index * 50,
                load.loadType,
                load.count,
                () => this.handleLoadPickup(load.loadType)
            );
            container.add(button);
        });
    }

    private createDeliverySection(
        container: Phaser.GameObjects.Container,
        currentLoads: LoadType[]
    ) {
        const deliverableLoads = this.getDeliverableLoads(currentLoads);
        
        if (deliverableLoads.length > 0) {
            const title = this.add.text(200, 0, "Available for Delivery:", {
                color: "#ffffff",
                fontSize: "18px"
            });
            container.add(title);

            deliverableLoads.forEach((load, index) => {
                const button = this.createLoadButton(
                    200, 40 + index * 50,
                    load.type,
                    1,
                    () => this.handleLoadDelivery(load)
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

    private getDeliverableLoads(currentLoads: LoadType[]): Array<{type: LoadType, payment: number}> {
        if (!this.player.hand) return [];
        
        return this.player.hand
            .filter(card => card.destinationCity === this.city.name)
            .filter(card => currentLoads.includes(card.resource))
            .map(card => ({
                type: card.resource,
                payment: card.payment
            }));
    }

    private async handleLoadPickup(loadType: LoadType) {
        try {
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
            
            this.player.trainState.loads.push(loadType);
            
            await this.gameStateService.updatePlayerLoads(
                this.player.id,
                this.player.trainState.loads
            );
            
            this.closeDialog();
        } catch (error) {
            console.error('Failed to pickup load:', error);
            // Show error message to user
        }
    }

    private async handleLoadDelivery(load: {type: LoadType, payment: number}) {
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
            
            await Promise.all([
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
                    load.type
                )
            ]);
            
            this.closeDialog();
        } catch (error) {
            console.error('Failed to deliver load:', error);
            // Show error message to user
        }
    }

    private closeDialog() {
        this.onClose();
    }
}
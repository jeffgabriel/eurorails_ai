import "phaser";
import { Player } from "../../shared/types/GameTypes";

export class TrainCard {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private player: Player;
  private loadSlots: Phaser.GameObjects.Rectangle[] = [];
  private trainCard: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, x: number, y: number, player: Player) {
    this.scene = scene;
    this.player = player;
    
    // Create main container
    this.container = scene.add.container(x, y);
    
    // Create train card using the appropriate image
    const trainType = player.trainType.toLowerCase().replace(/\s+/g, '');
    this.trainCard = scene.add.image(0, 0, `train_card_${trainType}`);
    this.trainCard.setOrigin(0, 0);
    this.trainCard.setScale(0.18); // Scale down to 18% of original size
    
    // Create load slots based on train capacity
    const capacity = player.trainType === "Heavy Freight" || player.trainType === "Superfreight" ? 3 : 2;
    this.createLoadSlots(capacity);
    
    // Add all elements to container
    this.container.add([this.trainCard]);
    this.loadSlots.forEach(slot => this.container.add(slot));
  }

  private createLoadSlots(capacity: number) {
    // Scale down slot size to match card scale
    const slotSize = 25; // Slightly smaller to match the circles
    const padding = 15;  // Increased to match spacing between circles
    
    // Position slots to match the white circles on the card
    // These values are relative to the scaled card size (18% of original)
    const startX = 55;  // About 1/3 across the card width
    const startY = 203; // Lowered to match circle position in bottom portion
    
    for (let i = 0; i < capacity; i++) {
      const slot = this.scene.add.rectangle(
        startX + (slotSize + padding) * i,
        startY,
        slotSize,
        slotSize,
        0x444444,
        0.3 // Make slots semi-transparent
      );
      slot.setStrokeStyle(1, 0xffffff, 0.5);
      this.loadSlots.push(slot);
    }
  }

  // Method to update load slots with current loads
  public updateLoads() {
    const currentLoads = this.player.trainState.loads || [];
    
    // Clear any existing load visuals
    this.loadSlots.forEach((slot, index) => {
      if (currentLoads[index]) {
        slot.setFillStyle(0x888888, 0.5); // Filled slot, semi-transparent
      } else {
        slot.setFillStyle(0x444444, 0.3); // Empty slot, more transparent
      }
    });
  }

  // Method to update train card when train type changes
  public updateTrainType() {
    // Update train card image
    const trainType = this.player.trainType.toLowerCase().replace(/\s+/g, '');
    this.trainCard.setTexture(`train_card_${trainType}`);
    
    // Update load slots
    const capacity = this.player.trainType === "Heavy Freight" || this.player.trainType === "Superfreight" ? 3 : 2;
    const currentCapacity = this.loadSlots.length;
    
    if (currentCapacity !== capacity) {
      this.loadSlots.forEach(slot => slot.destroy());
      this.loadSlots = [];
      this.createLoadSlots(capacity);
      this.loadSlots.forEach(slot => this.container.add(slot));
    }
  }

  // Method to show/hide the train card
  public setVisible(visible: boolean) {
    this.container.setVisible(visible);
  }

  // Method to get the container
  public getContainer(): Phaser.GameObjects.Container {
    return this.container;
  }

  // Method to destroy the train card
  public destroy() {
    this.container.destroy();
  }
} 
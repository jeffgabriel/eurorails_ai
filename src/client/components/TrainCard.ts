import "phaser";
import { Player, TrainType, TRAIN_PROPERTIES } from "../../shared/types/GameTypes";
import { LoadType } from "../../shared/types/LoadTypes";

export class TrainCard {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private player: Player;
  private loadSlots: Phaser.GameObjects.Rectangle[] = [];
  private loadTokens: Phaser.GameObjects.Container[] = [];
  private trainCard: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, x: number, y: number, player: Player) {
    this.scene = scene;
    this.player = player;
    
    // Create main container
    this.container = scene.add.container(x, y);
    
    // Create train card using the appropriate image
    const trainType = player.trainType.toLowerCase().replace(/[\s-]+/g, '');
    this.trainCard = scene.add.image(0, 0, `train_card_${trainType}`);
    this.trainCard.setOrigin(0, 0);
    this.trainCard.setScale(0.165); // Scale down to 18% of original size
    
    // Create load slots based on train capacity
    const capacity = TRAIN_PROPERTIES[player.trainType].capacity;
    this.createLoadSlots(capacity);
    
    // Add all elements to container
    this.container.add([this.trainCard]);
    this.loadSlots.forEach(slot => this.container.add(slot));
  }

  private createLoadSlots(capacity: number) {
    // Scale down slot size to match card scale
    const slotSize = 25; // Slightly smaller to match the circles
    const padding = 11;  // Increased to match spacing between circles
    
    // Position slots to match the white circles on the card
    // These values are relative to the scaled card size (18% of original)
    const startX = 51;  // About 1/3 across the card width
    const startY = 185; // Lowered to match circle position in bottom portion
    
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
    
    // Clear any existing load tokens
    this.loadTokens.forEach(token => token.destroy());
    this.loadTokens = [];
    
    // Update slots and add load tokens
    this.loadSlots.forEach((slot, index) => {
      if (currentLoads[index]) {
        // When occupied, make slot fully transparent
        slot.setFillStyle(0x444444, 0);
        
        // Create a container for the token and its background
        const tokenContainer = this.scene.add.container(slot.x, slot.y);
        
        // Add white circular background - increased radius
        const background = this.scene.add.circle(0, 0, 14, 0xffffff);
        tokenContainer.add(background);
        
        // Create load token sprite
        const loadToken = this.scene.add.image(
          0,
          0,
          `loadtoken-${currentLoads[index].toLowerCase()}`
        );
        
        // Scale the token to fit in the slot
        loadToken.setScale(0.25); // Slightly increased scale to match larger circle
        
        // Add token to container
        tokenContainer.add(loadToken);
        
        // Add token container to tracking array and main container
        this.loadTokens.push(tokenContainer);
        this.container.add(tokenContainer);
      } else {
        // Empty slot
        slot.setFillStyle(0x444444, 0.3);
      }
    });
  }

  // Method to update train card when train type changes
  public updateTrainType() {
    // Update train card image
    const trainType = this.player.trainType.toLowerCase().replace(/[\s-]+/g, '');
    this.trainCard.setTexture(`train_card_${trainType}`);
    
    // Update load slots
    const capacity = TRAIN_PROPERTIES[this.player.trainType].capacity;
    const currentCapacity = this.loadSlots.length;
    
    if (currentCapacity !== capacity) {
      // Clear existing load tokens
      this.loadTokens.forEach(token => token.destroy());
      this.loadTokens = [];
      
      // Clear existing slots
      this.loadSlots.forEach(slot => slot.destroy());
      this.loadSlots = [];
      
      // Create new slots
      this.createLoadSlots(capacity);
      this.loadSlots.forEach(slot => this.container.add(slot));
      
      // Update loads to show tokens in new slots
      this.updateLoads();
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
    // Clean up load tokens
    this.loadTokens.forEach(token => token.destroy());
    this.container.destroy();
  }
} 
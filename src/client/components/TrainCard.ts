import "phaser";
import { Player, TrainType, TRAIN_PROPERTIES } from "../../shared/types/GameTypes";
import { LoadType } from "../../shared/types/LoadTypes";

export class TrainCard {
  private scene: Phaser.Scene;
  private container: any;
  private player: Player;
  private loadSlots: Phaser.GameObjects.Rectangle[] = [];
  private loadTokens: Phaser.GameObjects.Container[] = [];
  private trainCard: Phaser.GameObjects.Image;
  private cardOffsetX: number = 0;
  private cardOffsetY: number = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, player: Player) {
    this.scene = scene;
    this.player = player;
    
    // Create main container
    // NOTE: When this container is added to a RexUI sizer, the sizer owns its position.
    // We keep x/y for non-sizer use, but the important part is giving it a stable size.
    this.container = (this.scene as any).rexUI.add
      .container({ x, y })
      .setName(`train-card-container`);
    
    // Validate player and trainType
    if (!player) {
      throw new Error('TrainCard: Player is required');
    }
    
    if (!player.trainType) {
      console.warn('TrainCard: Player trainType is undefined, defaulting to Freight');
      player.trainType = TrainType.Freight;
    }
    
    // Validate trainType exists in TRAIN_PROPERTIES
    if (!TRAIN_PROPERTIES[player.trainType]) {
      console.warn(`TrainCard: Unknown trainType "${player.trainType}", defaulting to Freight`);
      player.trainType = TrainType.Freight;
    }
    
    // Create train card using the appropriate image
    const trainType = player.trainType.toLowerCase().replace(/[\s_-]+/g, '');
    this.trainCard = scene.add.image(0, 0, `train_card_${trainType}`);
    this.trainCard.setOrigin(0, 0);
    this.trainCard.setScale(0.165); // Scale down to 18% of original size

    // ContainerLite's local (0,0) behaves like a center point; our card layout math
    // assumes (0,0) is top-left. Shift everything by (-w/2, -h/2) to reconcile.
    this.cardOffsetX = -this.trainCard.displayWidth / 2;
    this.cardOffsetY = -this.trainCard.displayHeight / 2;
    this.trainCard.setPosition(this.cardOffsetX, this.cardOffsetY);
    
    // Create load slots based on train capacity
    const capacity = TRAIN_PROPERTIES[player.trainType].capacity;
    this.createLoadSlots(capacity);
    
    // Add all elements to container
    this.container.addLocal(this.trainCard);
    this.loadSlots.forEach(slot => this.container.addLocal(slot));

    // Critical for RexUI sizers: ContainerLite must have an explicit footprint.
    // Use the scaled display size of the background image as the container size.
    this.container.setSize(this.trainCard.displayWidth, this.trainCard.displayHeight);
  }

  private createLoadSlots(capacity: number) {
    // Scale down slot size to match card scale
    const slotSize = 25; // Slightly smaller to match the circles
    const padding = 11;  // Increased to match spacing between circles
    
    // Position slots to match the white circles on the card
    // These values are relative to the scaled card size (18% of original)
    const startX = 51;  // About 1/3 across the card width (top-left-based)
    const startY = 185; // Lowered to match circle position in bottom portion (top-left-based)
    
    for (let i = 0; i < capacity; i++) {
      const slot = this.scene.add.rectangle(
        this.cardOffsetX + startX + (slotSize + padding) * i,
        this.cardOffsetY + startY,
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
        // IMPORTANT: Avoid NaN propagation from ContainerLite world/local transforms:
        // - Create at (0,0) so addLocal doesn't subtract undefined coords
        // - Add children at explicit local (0,0)
        // - Add to main TrainCard container
        // - Then set tokenContainer's *local* position to the slot's local coords
        const tokenContainer = (this.scene as any).rexUI.add.container({ x: 0, y: 0 });
        tokenContainer.setSize(1, 1);
        
        // Add white circular background - increased radius
        const background = this.scene.add.circle(0, 0, 14, 0xffffff);
        tokenContainer.addLocal(background);
        
        // Create load token sprite
        const loadToken = this.scene.add.image(
          0,
          0,
          `loadtoken-${currentLoads[index].toLowerCase()}`
        );
        
        // Scale the token to fit in the slot
        loadToken.setScale(0.25); // Slightly increased scale to match larger circle
        
        // Add token to container
        tokenContainer.addLocal(loadToken);
        
        // Add token container to tracking array and main container
        this.loadTokens.push(tokenContainer);
        this.container.addLocal(tokenContainer);
        tokenContainer.setPosition(slot.x, slot.y);
      } else {
        // Empty slot
        slot.setFillStyle(0x444444, 0.3);
      }
    });
  }

  // Method to update train card when train type changes
  public updateTrainType() {
    // Validate trainType
    if (!this.player.trainType) {
      console.warn('TrainCard.updateTrainType: Player trainType is undefined, defaulting to Freight');
      this.player.trainType = TrainType.Freight;
    }
    
    if (!TRAIN_PROPERTIES[this.player.trainType]) {
      console.warn(`TrainCard.updateTrainType: Unknown trainType "${this.player.trainType}", defaulting to Freight`);
      this.player.trainType = TrainType.Freight;
    }
    
    // Update train card image
    const trainType = this.player.trainType.toLowerCase().replace(/[\s_-]+/g, '');
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

  // Method to get the container
  public getContainer(): any {
    return this.container;
  }

  // Method to destroy the train card
  public destroy() {
    // Clean up load tokens
    this.loadTokens.forEach(token => token.destroy());
    this.container.destroy();
  }
} 
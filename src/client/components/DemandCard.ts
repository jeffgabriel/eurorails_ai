import { Scene } from 'phaser';
import { DemandCard as DemandCardType } from '../../shared/types/DemandCard';
import { LoadType } from '../../shared/types/LoadTypes';

export class DemandCard extends Phaser.GameObjects.Container {
  private readonly CARD_WIDTH = 170;
  private readonly CARD_HEIGHT = 255;
  private readonly DEMAND_SPACING = 50;
  private readonly DEMAND_START_Y = 43;

  constructor(scene: Scene, x: number, y: number, card?: DemandCardType) {
    super(scene, x, y);

    // Add the card template background
    const template = scene.add.image(0, 0, 'demand-template')
      .setOrigin(0.5)
      .setDisplaySize(this.CARD_WIDTH, this.CARD_HEIGHT);
    this.add(template);

    if (card) {
      // Add each demand to its slot
      card.demands.forEach((demand, index) => {
        const slotY = this.DEMAND_START_Y + (index * this.DEMAND_SPACING);

        // Add city name
        const cityText = scene.add.text(-68, slotY - 8, demand.city, {
          fontSize: '12px',
          color: '#000000',
          align: 'left'
        }).setOrigin(0, 0.5);
        this.add(cityText);

        // Add resource icon
        const resourceIcon = scene.add.image(0, slotY, `load-${demand.resource.toLowerCase()}`)
          .setDisplaySize(26, 26)
          .setOrigin(0.5);
        this.add(resourceIcon);

        // Add payment amount
        const paymentText = scene.add.text(51, slotY - 8, `${demand.payment}M`, {
          fontSize: '14px',
          color: '#000000',
          align: 'right'
        }).setOrigin(1, 0.5);
        this.add(paymentText);
      });
    } else {
      // If no card data, show empty card state
      const emptyText = scene.add.text(0, 0, 'Empty\nCard\nSlot', {
        fontSize: '14px',
        color: '#666666',
        align: 'center'
      }).setOrigin(0.5);
      this.add(emptyText);
    }

    scene.add.existing(this);
  }
} 
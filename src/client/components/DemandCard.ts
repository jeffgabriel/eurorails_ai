import { Scene } from 'phaser';
import { DemandCard as DemandCardType } from '../../shared/types/DemandCard';
import { LoadType } from '../../shared/types/LoadTypes';

export class DemandCard extends Phaser.GameObjects.Container {
  private readonly CARD_WIDTH = 170;
  private readonly CARD_HEIGHT = 255;
  private readonly DEMAND_SPACING = 70; // Space between demand sections
  private readonly DEMAND_START_Y = -65; // Start higher to accommodate 3 sections
  private readonly SECTION_HEIGHT = 45; // Height of each demand section

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
        const sectionY = this.DEMAND_START_Y + (index * this.DEMAND_SPACING);

        // Add city name at top of section
        const cityText = scene.add.text(0, sectionY - 25, demand.city.toUpperCase(), {
          fontSize: '14px',
          color: '#000000',
          fontFamily: 'Arial',
          fontStyle: 'bold', // Make city name bold
          align: 'center'
        }).setOrigin(0.5, 0.5);
        this.add(cityText);

        // Add large centered resource icon
        const resourceIcon = scene.add.image(0, sectionY + 2, `load-${demand.resource.toLowerCase()}`)
          .setDisplaySize(33, 33)
          .setOrigin(0.48);
        this.add(resourceIcon);

        // Add payment amount in bottom right
        const paymentText = scene.add.text(50, sectionY + 20, `ECU ${demand.payment}M`, {
          fontSize: '9px',
          color: '#000000',
          fontFamily: 'Arial', // Same font as city name for consistency
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
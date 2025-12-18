import { Scene } from 'phaser';
import { DemandCard as DemandCardType } from '../../shared/types/DemandCard';
import ContainerLite from 'phaser3-rex-plugins/plugins/containerlite.js';

export class DemandCard extends ContainerLite {
  private readonly CARD_WIDTH = 170;
  private readonly CARD_HEIGHT = 255;
  private readonly DEMAND_SPACING = 70; // Space between demand sections
  private readonly DEMAND_START_Y = -65; // Start higher to accommodate 3 sections
  private readonly SECTION_HEIGHT = 45; // Height of each demand section

  // Purely-visual "mark" state: which demand section is highlighted, if any.
  private markedDemandIndex: number | null = null;
  private readonly markIcons: Phaser.GameObjects.Text[] = [];
  private readonly markHitAreas: Phaser.GameObjects.Zone[] = [];
  private onMarkedDemandIndexChange?: (cardId: number, markedIndex: number | null) => void;
  private cardId?: number;

  constructor(
    scene: Scene,
    x: number,
    y: number,
    card?: DemandCardType,
    options?: {
      markedDemandIndex?: number | null;
      onMarkedDemandIndexChange?: (cardId: number, markedIndex: number | null) => void;
    }
  ) {
    super(scene, x, y);
    // Critical for RexUI sizers: ContainerLite must have an explicit footprint.
    this.setSize(this.CARD_WIDTH, this.CARD_HEIGHT);
    this.markedDemandIndex = options?.markedDemandIndex ?? null;
    this.onMarkedDemandIndexChange = options?.onMarkedDemandIndexChange;
    this.cardId = card?.id;

    // Add the card template background
    const template = scene.add.image(0, 0, 'demand-template')
      .setOrigin(0.5)
      .setDisplaySize(this.CARD_WIDTH, this.CARD_HEIGHT);
    this.add(template);

    if (card) {
      this.name = `demand-card-${card.id}`;
      // Add each demand to its slot
      card.demands.forEach((demand, index) => {
        const sectionY = this.DEMAND_START_Y + (index * this.DEMAND_SPACING);

        // Clickable zone for toggling the mark (purely visual).
        const hitArea = scene.add
          .zone(0, sectionY, this.CARD_WIDTH - 20, this.SECTION_HEIGHT)
          .setOrigin(0.5, 0.5)
          .setInteractive({ useHandCursor: true });
        hitArea.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
          if (pointer.event) pointer.event.stopPropagation();
          this.toggleMarkedDemandIndex(index);
        });
        this.add(hitArea);
        this.markHitAreas.push(hitArea);

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

        // Mark icon (green check) - toggled via click.
        const mark = scene.add
          .text(-58, sectionY + 4, '✓', {
            fontSize: '26px',
            color: '#18a418',
            fontFamily: 'Arial',
            fontStyle: 'bold',
          })
          .setOrigin(0.5, 0.5)
          .setVisible(false);
        // Subtle outline for readability on light backgrounds.
        mark.setStroke('#0b5e0b', 2);
        this.add(mark);
        this.markIcons[index] = mark;
      });

      // Apply initial mark state after all sections are created.
      this.syncMarkIcons();
    } else {
      // If no card data, show empty card state
      const emptyText = scene.add.text(0, 0, 'Empty\nCard\nSlot', {
        fontSize: '14px',
        color: '#666666',
        align: 'center'
      }).setOrigin(0.5);
      this.add(emptyText);
    }

    // scene.add.existing(this);
  }

  private toggleMarkedDemandIndex(index: number): void {
    if (!this.cardId) return;
    const next = this.markedDemandIndex === index ? null : index;
    this.setMarkedDemandIndex(next);
  }

  private setMarkedDemandIndex(index: number | null): void {
    if (this.markedDemandIndex === index) return;
    this.markedDemandIndex = index;
    this.syncMarkIcons();
    if (this.cardId !== undefined) {
      this.onMarkedDemandIndexChange?.(this.cardId, this.markedDemandIndex);
    }
  }

  private syncMarkIcons(): void {
    // Ensure only one "on" at a time.
    for (let i = 0; i < this.markIcons.length; i++) {
      const icon = this.markIcons[i];
      if (!icon) continue;
      icon.setVisible(this.markedDemandIndex === i);
    }
  }
} 
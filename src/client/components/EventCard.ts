import { Scene } from 'phaser';
import ContainerLite from 'phaser3-rex-plugins/plugins/containerlite.js';
import { EventCard as EventCardType, EventCardType as EventCardTypeEnum } from '../../shared/types/EventCard';
import { UI_FONT_FAMILY } from '../config/uiFont';

/** Visual dimensions of the event card panel */
const CARD_WIDTH = 320;
const CARD_HEIGHT = 300;

/** Maps EventCardType enum values to display icons (emoji/text) */
const EVENT_TYPE_ICONS: Record<EventCardTypeEnum, string> = {
  [EventCardTypeEnum.Strike]: '🚫',
  [EventCardTypeEnum.Derailment]: '⚠️',
  [EventCardTypeEnum.Snow]: '❄️',
  [EventCardTypeEnum.Flood]: '🌊',
  [EventCardTypeEnum.ExcessProfitTax]: '💰',
};

/**
 * Presentational Phaser component for displaying a single event card's details.
 * Follows the ContainerLite pattern established by DemandCard.ts.
 */
export class EventCard extends ContainerLite {
  constructor(scene: Scene, x: number, y: number, card: EventCardType) {
    super(scene, x, y);
    this.setSize(CARD_WIDTH, CARD_HEIGHT);
    this.name = `event-card-${card.id}`;

    this.buildLayout(scene, card);
  }

  private buildLayout(scene: Scene, card: EventCardType): void {
    // Background panel
    const bg = scene.add
      .rectangle(0, 0, CARD_WIDTH, CARD_HEIGHT, 0x1a1a2e)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0xf0a500);
    this.add(bg);

    // Header row: type icon + card ID
    const icon = EVENT_TYPE_ICONS[card.type] ?? '📋';
    const headerText = scene.add
      .text(
        -(CARD_WIDTH / 2) + 16,
        -(CARD_HEIGHT / 2) + 14,
        `${icon}  EVENT CARD #${card.id}`,
        {
          fontSize: '13px',
          color: '#f0a500',
          fontFamily: UI_FONT_FAMILY,
          fontStyle: 'bold',
        }
      )
      .setOrigin(0, 0);
    this.add(headerText);

    // Horizontal divider beneath header
    const divider = scene.add
      .rectangle(0, -(CARD_HEIGHT / 2) + 36, CARD_WIDTH - 16, 1, 0xf0a500)
      .setOrigin(0.5, 0.5);
    this.add(divider);

    // Title
    const titleText = scene.add
      .text(0, -(CARD_HEIGHT / 2) + 60, card.title.toUpperCase(), {
        fontSize: '20px',
        color: '#ffffff',
        fontFamily: UI_FONT_FAMILY,
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: CARD_WIDTH - 24 },
      })
      .setOrigin(0.5, 0);
    this.add(titleText);

    // Description
    const descText = scene.add
      .text(0, -(CARD_HEIGHT / 2) + 100, card.description, {
        fontSize: '13px',
        color: '#cccccc',
        fontFamily: UI_FONT_FAMILY,
        align: 'center',
        wordWrap: { width: CARD_WIDTH - 32 },
      })
      .setOrigin(0.5, 0);
    this.add(descText);
  }
}

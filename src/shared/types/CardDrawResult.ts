import { DemandCard } from './DemandCard';
import { EventCard } from './EventCard';

/**
 * Discriminated union returned by DemandDeckService.drawCard().
 *
 * Callers must check `result.type` to determine which card was drawn:
 *
 * ```ts
 * const result = deckService.drawCard();
 * if (result === null) { // deck exhausted }
 * else if (result.type === 'demand') { // result.card is DemandCard }
 * else { // result.type === 'event', result.card is EventCard }
 * ```
 */
export type CardDrawResult =
  | { readonly type: 'demand'; readonly card: DemandCard }
  | { readonly type: 'event'; readonly card: EventCard };

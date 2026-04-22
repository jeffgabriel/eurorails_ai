/**
 * EventCardService — Orchestrator for event card effect processing.
 *
 * Dispatches to per-type private handlers, wraps all DB mutations in a single
 * transaction with SELECT … FOR UPDATE concurrency locking, and returns a
 * structured EventCardResult to the caller.
 *
 * Boundaries (enforced by the spec):
 * - Does NOT persist active effects to games.active_event (Project 3).
 * - Does NOT broadcast socket events (Project 3).
 * - Does NOT implement the draw loop (Project 3).
 */

import { db } from '../db/index';
import { PoolClient } from 'pg';
import {
  EventCard,
  EventCardType,
  EventCardResult,
  PerPlayerEffect,
  ActiveEffectDescriptor,
  StrikeEffect,
  DerailmentEffect,
  SnowEffect,
  FloodEffect,
  ExcessProfitTaxEffect,
} from '../../shared/types/EventCard';
import { TerrainType } from '../../shared/types/GameTypes';
import { AreaOfEffectService } from './AreaOfEffectService';
import { TrackService } from './trackService';

// ── EventCardService ──────────────────────────────────────────────────────────

export class EventCardService {
  /**
   * Process an event card, applying all immediate game-state mutations within
   * a single database transaction.
   *
   * If an external `client` is provided (e.g., from Project 3's draw loop),
   * that transaction is used and NOT committed/rolled back here — the caller
   * is responsible for lifecycle management.
   *
   * If no `client` is provided, this method opens its own connection, wraps
   * mutations in BEGIN/COMMIT, and rolls back on error.
   *
   * All rows to be mutated are locked with SELECT … FOR UPDATE before any
   * writes occur (concurrency-locking pattern, consistent with playerService.ts).
   *
   * @param gameId           The game being affected
   * @param card             The drawn EventCard
   * @param drawingPlayerId  Player ID of whoever drew the card
   * @param externalClient   Optional external PoolClient (caller owns lifecycle)
   * @returns Structured result describing every state change made
   */
  static async processEventCard(
    gameId: string,
    card: EventCard,
    drawingPlayerId: string,
    externalClient?: PoolClient,
  ): Promise<EventCardResult> {
    const ownTransaction = !externalClient;
    const client = externalClient ?? (await db.connect());

    try {
      if (ownTransaction) {
        await client.query('BEGIN');
      }

      console.info(
        `[EventCardService] Processing event card: cardId=${card.id} type=${card.type} gameId=${gameId} drawingPlayer=${drawingPlayerId}`,
      );

      let result: EventCardResult;

      switch (card.type) {
        case EventCardType.Strike:
          result = await EventCardService.processStrike(
            gameId,
            card,
            drawingPlayerId,
            card.effectConfig as StrikeEffect,
            client,
          );
          break;

        case EventCardType.Derailment:
          result = await EventCardService.processDerailment(
            gameId,
            card,
            drawingPlayerId,
            card.effectConfig as DerailmentEffect,
            client,
          );
          break;

        case EventCardType.Snow:
          result = await EventCardService.processSnow(
            gameId,
            card,
            drawingPlayerId,
            card.effectConfig as SnowEffect,
            client,
          );
          break;

        case EventCardType.Flood:
          result = await EventCardService.processFlood(
            gameId,
            card,
            drawingPlayerId,
            card.effectConfig as FloodEffect,
            client,
          );
          break;

        case EventCardType.ExcessProfitTax:
          result = await EventCardService.processExcessProfitTax(
            gameId,
            card,
            drawingPlayerId,
            card.effectConfig as ExcessProfitTaxEffect,
            client,
          );
          break;

        default:
          throw new Error(`Unknown EventCardType: ${(card as EventCard).type}`);
      }

      if (ownTransaction) {
        await client.query('COMMIT');
      }

      console.info(
        `[EventCardService] Completed event card: cardId=${card.id} type=${card.type} ` +
          `affectedPlayers=${result.perPlayerEffects.length}`,
      );

      return result;
    } catch (err) {
      if (ownTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('[EventCardService] Rollback failed:', rollbackErr);
        }
      }
      throw err;
    } finally {
      if (ownTransaction) {
        client.release();
      }
    }
  }

  // ── Private handlers ──────────────────────────────────────────────────────

  /**
   * Strike handler.
   *
   * Coastal variant (#121, #122): Identifies all mileposts within `coastalRadius`
   * of any coast. Produces `no_pickup_delivery` descriptors for every player
   * in the affected zone — NO DB mutation (enforcement is Project 3).
   *
   * Rail variant (#123): Produces a `no_movement` descriptor for the drawing
   * player only — NO DB mutation (enforcement is Project 3).
   */
  private static async processStrike(
    gameId: string,
    card: EventCard,
    drawingPlayerId: string,
    effect: StrikeEffect,
    client: PoolClient,
  ): Promise<EventCardResult> {
    if (effect.variant === 'coastal') {
      const radius = effect.coastalRadius ?? 3;
      const coastalZone = AreaOfEffectService.getCoastalMileposts(radius);
      const affectedPlayers = await AreaOfEffectService.getPlayersInZone(gameId, coastalZone, client);

      // SELECT … FOR UPDATE on affected player rows (idempotent lock, no mutation in this project)
      if (affectedPlayers.length > 0) {
        const ids = affectedPlayers.map(p => p.playerId);
        await client.query(
          `SELECT id FROM players WHERE game_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`,
          [gameId, ids],
        );
      }

      const perPlayerEffects: PerPlayerEffect[] = affectedPlayers.map(p => ({
        playerId: p.playerId,
        effectType: 'no_pickup_delivery' as const,
        details: `Coastal strike: no pickup/delivery within ${radius} mileposts of coast`,
      }));

      const descriptor: ActiveEffectDescriptor = await buildDescriptor(
        card, drawingPlayerId, gameId, client, Array.from(coastalZone),
      );

      return {
        cardId: card.id,
        cardType: card.type,
        drawingPlayerId,
        affectedZone: Array.from(coastalZone),
        perPlayerEffects,
        floodSegmentsRemoved: [],
        persistentEffectDescriptor: descriptor,
      };
    } else {
      // Rail variant: no_movement for drawing player only; no zone
      return {
        cardId: card.id,
        cardType: card.type,
        drawingPlayerId,
        affectedZone: [],
        perPlayerEffects: [
          {
            playerId: drawingPlayerId,
            effectType: 'no_movement' as const,
            details: 'Rail strike: drawing player cannot move on their own track',
          },
        ],
        floodSegmentsRemoved: [],
        persistentEffectDescriptor: await buildDescriptor(
          card, drawingPlayerId, gameId, client, [],
        ),
      };
    }
  }

  /**
   * Derailment handler.
   *
   * Identifies all trains within `radius` mileposts of any listed city.
   * For each affected player:
   *   - Removes the first load (deterministic choice for server-side processing)
   *   - Produces a `load_lost` and `turn_lost` descriptor
   *   - Writes the updated loads to the DB
   */
  private static async processDerailment(
    gameId: string,
    card: EventCard,
    drawingPlayerId: string,
    effect: DerailmentEffect,
    client: PoolClient,
  ): Promise<EventCardResult> {
    // Compute zone as union of areas around each city
    const zone = new Set<string>();
    for (const cityName of effect.cities) {
      const cityZone = AreaOfEffectService.getZoneAroundCity(cityName, effect.radius);
      for (const key of cityZone) zone.add(key);
    }

    const affectedPlayers = await AreaOfEffectService.getPlayersInZone(gameId, zone, client);

    const perPlayerEffects: PerPlayerEffect[] = [];

    if (affectedPlayers.length > 0) {
      // Lock all affected player rows
      const ids = affectedPlayers.map(p => p.playerId);
      const lockedRows = await client.query(
        `SELECT id, loads FROM players WHERE game_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`,
        [gameId, ids],
      );

      for (const row of lockedRows.rows) {
        const playerId = row.id as string;
        const currentLoads = (row.loads || []) as string[];

        if (currentLoads.length > 0) {
          // Remove first load (deterministic; rulebook says player chooses — see ADR-2.5)
          const removedLoad = currentLoads[0];
          const newLoads = currentLoads.slice(1);

          await client.query(
            `UPDATE players SET loads = $1 WHERE id = $2 AND game_id = $3`,
            [newLoads, playerId, gameId],
          );

          perPlayerEffects.push({
            playerId,
            effectType: 'load_lost' as const,
            details: `Derailment: lost load '${removedLoad}' (deterministic first-load removal)`,
            amount: 1,
          });
        }

        // All affected players lose a turn (computed; enforcement is Project 3)
        perPlayerEffects.push({
          playerId,
          effectType: 'turn_lost' as const,
          details: `Derailment near ${effect.cities.join(' or ')}: lose 1 turn`,
        });
      }
    }

    const descriptor: ActiveEffectDescriptor = await buildDescriptor(
      card, drawingPlayerId, gameId, client, Array.from(zone),
    );

    return {
      cardId: card.id,
      cardType: card.type,
      drawingPlayerId,
      affectedZone: Array.from(zone),
      perPlayerEffects,
      floodSegmentsRemoved: [],
      persistentEffectDescriptor: descriptor,
    };
  }

  /**
   * Snow handler.
   *
   * Computes the half-rate zone around `centerCity` (radius `effect.radius`).
   * Computes the blocked-terrain subset (mileposts in zone with terrain in
   * `effect.blockedTerrain`).
   * Produces `speed_halved` descriptors for all players in the zone.
   * No immediate DB mutation — enforcement is Project 3.
   */
  private static async processSnow(
    gameId: string,
    card: EventCard,
    drawingPlayerId: string,
    effect: SnowEffect,
    client: PoolClient,
  ): Promise<EventCardResult> {
    const halfRateZone = AreaOfEffectService.getZoneAroundCity(effect.centerCity, effect.radius);
    const blockedTerrainZone = AreaOfEffectService.getZoneAroundCity(
      effect.centerCity,
      effect.radius,
      effect.blockedTerrain,
    );

    const affectedPlayers = await AreaOfEffectService.getPlayersInZone(gameId, halfRateZone, client);

    if (affectedPlayers.length > 0) {
      const ids = affectedPlayers.map(p => p.playerId);
      // Lock rows (no mutation — enforcement is Project 3)
      await client.query(
        `SELECT id FROM players WHERE game_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`,
        [gameId, ids],
      );
    }

    const perPlayerEffects: PerPlayerEffect[] = affectedPlayers.map(p => ({
      playerId: p.playerId,
      effectType: 'speed_halved' as const,
      details: `Snow near ${effect.centerCity} (radius ${effect.radius}): half-rate movement. Blocked terrain zone size: ${blockedTerrainZone.size}`,
    }));

    const descriptor: ActiveEffectDescriptor = await buildDescriptor(
      card, drawingPlayerId, gameId, client, Array.from(halfRateZone),
    );

    return {
      cardId: card.id,
      cardType: card.type,
      drawingPlayerId,
      affectedZone: Array.from(halfRateZone),
      perPlayerEffects,
      floodSegmentsRemoved: [],
      persistentEffectDescriptor: descriptor,
    };
  }

  /**
   * Flood handler.
   *
   * Removes all track segments crossing the named river from every player's
   * `player_tracks.segments` JSONB array.
   * Uses `TrackService.removeSegmentsCrossingRiver` which handles SELECT FOR UPDATE.
   */
  private static async processFlood(
    gameId: string,
    card: EventCard,
    drawingPlayerId: string,
    effect: FloodEffect,
    client: PoolClient,
  ): Promise<EventCardResult> {
    const removalResults = await TrackService.removeSegmentsCrossingRiver(
      client,
      gameId,
      effect.river,
    );

    const perPlayerEffects: PerPlayerEffect[] = removalResults.map(r => ({
      playerId: r.playerId,
      effectType: 'track_erased' as const,
      details: `Flood on ${effect.river}: ${r.removedCount} segment(s) removed, new total cost ${r.newTotalCost}`,
      amount: r.removedCount,
    }));

    const floodSegmentsRemoved = removalResults.map(r => ({
      playerId: r.playerId,
      removedCount: r.removedCount,
    }));

    const descriptor: ActiveEffectDescriptor = await buildDescriptor(
      card, drawingPlayerId, gameId, client, [],
    );

    return {
      cardId: card.id,
      cardType: card.type,
      drawingPlayerId,
      affectedZone: [],
      perPlayerEffects,
      floodSegmentsRemoved,
      persistentEffectDescriptor: descriptor,
    };
  }

  /**
   * Excess Profit Tax handler.
   *
   * Applies the rulebook tax brackets to every player's cash.
   * Brackets are sorted highest-threshold-first; the first matching bracket
   * determines the tax amount.
   */
  private static async processExcessProfitTax(
    gameId: string,
    card: EventCard,
    drawingPlayerId: string,
    effect: ExcessProfitTaxEffect,
    client: PoolClient,
  ): Promise<EventCardResult> {
    // Lock all players in the game
    const lockedRows = await client.query(
      `SELECT id, money FROM players WHERE game_id = $1 FOR UPDATE`,
      [gameId],
    );

    const perPlayerEffects: PerPlayerEffect[] = [];

    for (const row of lockedRows.rows) {
      const playerId = row.id as string;
      const money = row.money as number;

      // Find the first bracket whose threshold <= money (brackets sorted highest first)
      const bracket = effect.brackets.find(b => money >= b.threshold);
      const tax = bracket ? bracket.tax : 0;

      if (tax > 0) {
        const newMoney = Math.max(0, money - tax);
        await client.query(
          `UPDATE players SET money = $1 WHERE id = $2 AND game_id = $3`,
          [newMoney, playerId, gameId],
        );

        perPlayerEffects.push({
          playerId,
          effectType: 'tax_paid' as const,
          details: `Excess Profit Tax: paid ${tax}M ECU (had ${money}M, threshold ${bracket!.threshold}M)`,
          amount: tax,
        });
      }
    }

    return {
      cardId: card.id,
      cardType: card.type,
      drawingPlayerId,
      affectedZone: [],
      perPlayerEffects,
      floodSegmentsRemoved: [],
      // No persistent effect — ExcessProfitTax is a one-shot event
    };
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Build an `ActiveEffectDescriptor` by reading the drawing player's current
 * turn number from the DB.
 */
async function buildDescriptor(
  card: EventCard,
  drawingPlayerId: string,
  gameId: string,
  client: PoolClient,
  affectedZone: string[],
): Promise<ActiveEffectDescriptor> {
  // Query the drawing player's turn number and their index (ORDER BY created_at)
  const playerRows = await client.query(
    `SELECT id, current_turn_number FROM players WHERE game_id = $1 ORDER BY created_at ASC`,
    [gameId],
  );

  let drawingPlayerIndex = 0;
  let turnNumber = 1;

  for (let i = 0; i < playerRows.rows.length; i++) {
    if (playerRows.rows[i].id === drawingPlayerId) {
      drawingPlayerIndex = i;
      turnNumber = (playerRows.rows[i].current_turn_number as number) || 1;
      break;
    }
  }

  return {
    cardId: card.id,
    drawingPlayerId,
    drawingPlayerIndex,
    expiresAfterTurnNumber: turnNumber + 1,
    affectedZone,
  };
}

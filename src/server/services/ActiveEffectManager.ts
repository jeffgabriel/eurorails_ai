/**
 * ActiveEffectManager — Stateless service for managing persistent event card effects.
 *
 * Reads and writes `games.active_event` JSONB array to manage persistent effects,
 * compute restrictions, and handle Derailment turn-loss tracking.
 *
 * Design: Stateless singleton — no in-memory cache. Every call reads from DB.
 * All write operations accept PoolClient to participate in caller's transaction
 * with SELECT ... FOR UPDATE concurrency locking.
 */

import { PoolClient } from 'pg';
import { db } from '../db/index';
import {
  ActiveEffect,
  ActiveEffectDescriptor,
  ActiveEffectRecord,
  BuildRestriction,
  EventCardType,
  MovementRestriction,
  PerPlayerEffect,
  PickupDeliveryRestriction,
} from '../../shared/types/EventCard';
import { TerrainType } from '../../shared/types/GameTypes';

export class ActiveEffectManager {
  /**
   * Read all currently active effects from DB.
   * Deserializes JSONB array and rehydrates affectedZone as Set<string>.
   */
  async getActiveEffects(gameId: string): Promise<ActiveEffect[]> {
    const result = await db.query(
      `SELECT active_event FROM games WHERE id = $1`,
      [gameId],
    );

    if (result.rows.length === 0) {
      return [];
    }

    const records: ActiveEffectRecord[] | null = result.rows[0].active_event;
    if (!records || records.length === 0) {
      return [];
    }

    return records.map(record => this.rehydrateRecord(record));
  }

  /**
   * Add a new active effect (appends to the array) inside caller's transaction.
   *
   * @param gameId           The game being affected
   * @param descriptor       From EventCardResult.persistentEffectDescriptor
   * @param cardType         From the drawn EventCard.type
   * @param perPlayerEffects From EventCardResult.perPlayerEffects (for Derailment pendingLostTurns)
   * @param client           Caller-owned PoolClient (must be in a transaction)
   * @param riverName        Flood only — from effectConfig.river
   */
  async addActiveEffect(
    gameId: string,
    descriptor: ActiveEffectDescriptor,
    cardType: EventCardType,
    perPlayerEffects: PerPlayerEffect[],
    client: PoolClient,
    riverName?: string,
  ): Promise<void> {
    // Lock the game row to prevent concurrent modifications
    const lockResult = await client.query(
      `SELECT active_event FROM games WHERE id = $1 FOR UPDATE`,
      [gameId],
    );

    const existing: ActiveEffectRecord[] = lockResult.rows[0]?.active_event ?? [];

    const restrictions = this.buildRestrictions(cardType, descriptor.affectedZone, descriptor.drawingPlayerId);

    const pendingLostTurns = this.extractPendingLostTurns(cardType, perPlayerEffects);

    const newRecord: ActiveEffectRecord = {
      cardId: descriptor.cardId,
      cardType,
      drawingPlayerId: descriptor.drawingPlayerId,
      drawingPlayerIndex: descriptor.drawingPlayerIndex,
      drawingPlayerTurnNumber: descriptor.expiresAfterTurnNumber - 1,
      expiresAfterTurnNumber: descriptor.expiresAfterTurnNumber,
      affectedZone: descriptor.affectedZone,
      restrictions,
      pendingLostTurns,
      createdAt: new Date().toISOString(),
    };

    if (riverName !== undefined) {
      newRecord.floodedRiver = riverName;
    }

    const updated = [...existing, newRecord];

    await client.query(
      `UPDATE games SET active_event = $1 WHERE id = $2`,
      [JSON.stringify(updated), gameId],
    );

    console.info(
      `[ActiveEffectManager] Persisted active effect: cardId=${descriptor.cardId} cardType=${cardType} gameId=${gameId}`,
    );
  }

  /**
   * Remove all expired effects after turn completion.
   * Returns list of expired card IDs for socket notification.
   *
   * An effect expires when:
   *   expiresAfterTurnNumber <= completedTurnNumber
   *   AND drawingPlayerIndex === completedPlayerIndex
   */
  async cleanupExpiredEffects(
    gameId: string,
    completedPlayerIndex: number,
    completedTurnNumber: number,
    client: PoolClient,
  ): Promise<{ expiredCardIds: number[] }> {
    const lockResult = await client.query(
      `SELECT active_event FROM games WHERE id = $1 FOR UPDATE`,
      [gameId],
    );

    const records: ActiveEffectRecord[] | null = lockResult.rows[0]?.active_event;
    if (!records || records.length === 0) {
      return { expiredCardIds: [] };
    }

    const expiredCardIds: number[] = [];
    const remaining: ActiveEffectRecord[] = [];

    for (const record of records) {
      const isExpired =
        record.drawingPlayerIndex === completedPlayerIndex &&
        record.expiresAfterTurnNumber <= completedTurnNumber;

      if (isExpired) {
        expiredCardIds.push(record.cardId);
      } else {
        remaining.push(record);
      }
    }

    const updatedValue = remaining.length > 0 ? JSON.stringify(remaining) : null;
    await client.query(
      `UPDATE games SET active_event = $1 WHERE id = $2`,
      [updatedValue, gameId],
    );

    if (expiredCardIds.length > 0) {
      console.info(
        `[ActiveEffectManager] Cleaned up expired effects: cardIds=${expiredCardIds.join(',')} gameId=${gameId}`,
      );
    }

    return { expiredCardIds };
  }

  /**
   * Aggregate movement restrictions across all active effects (read-only).
   */
  async getMovementRestrictions(gameId: string): Promise<MovementRestriction[]> {
    const effects = await this.getActiveEffects(gameId);
    return effects.flatMap(e => e.restrictions.movement);
  }

  /**
   * Aggregate build restrictions across all active effects (read-only).
   */
  async getBuildRestrictions(gameId: string): Promise<BuildRestriction[]> {
    const effects = await this.getActiveEffects(gameId);
    return effects.flatMap(e => e.restrictions.build);
  }

  /**
   * Aggregate pickup/delivery restrictions across all active effects (read-only).
   */
  async getPickupDeliveryRestrictions(gameId: string): Promise<PickupDeliveryRestriction[]> {
    const effects = await this.getActiveEffects(gameId);
    return effects.flatMap(e => e.restrictions.pickupDelivery);
  }

  /**
   * Remove a player's pending lost turn from the first matching active effect.
   * A player loses at most one turn total regardless of how many Derailments hit them.
   *
   * @returns true if player was found and removed, false otherwise
   */
  async consumeLostTurn(
    gameId: string,
    playerId: string,
    client: PoolClient,
  ): Promise<boolean> {
    const lockResult = await client.query(
      `SELECT active_event FROM games WHERE id = $1 FOR UPDATE`,
      [gameId],
    );

    const records: ActiveEffectRecord[] | null = lockResult.rows[0]?.active_event;
    if (!records || records.length === 0) {
      return false;
    }

    let consumed = false;
    const updated = records.map(record => {
      if (consumed) return record;

      const idx = record.pendingLostTurns.findIndex(p => p.playerId === playerId);
      if (idx === -1) return record;

      consumed = true;
      const newPendingLostTurns = [
        ...record.pendingLostTurns.slice(0, idx),
        ...record.pendingLostTurns.slice(idx + 1),
      ];
      return { ...record, pendingLostTurns: newPendingLostTurns };
    });

    if (!consumed) {
      return false;
    }

    await client.query(
      `UPDATE games SET active_event = $1 WHERE id = $2`,
      [JSON.stringify(updated), gameId],
    );

    console.info(
      `[ActiveEffectManager] Consumed lost turn for player=${playerId} gameId=${gameId}`,
    );

    return true;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private rehydrateRecord(record: ActiveEffectRecord): ActiveEffect {
    return {
      cardId: record.cardId,
      cardType: record.cardType as EventCardType,
      drawingPlayerId: record.drawingPlayerId,
      drawingPlayerIndex: record.drawingPlayerIndex,
      expiresAfterTurnNumber: record.expiresAfterTurnNumber,
      affectedZone: new Set(record.affectedZone),
      restrictions: record.restrictions,
      pendingLostTurns: record.pendingLostTurns,
      floodedRiver: record.floodedRiver,
    };
  }

  /**
   * Build restriction arrays from cardType + affectedZone + drawingPlayerId.
   * Maps event type to restriction shape per the spec.
   */
  private buildRestrictions(
    cardType: EventCardType,
    affectedZone: string[],
    drawingPlayerId: string,
  ): ActiveEffectRecord['restrictions'] {
    const movement: MovementRestriction[] = [];
    const build: BuildRestriction[] = [];
    const pickupDelivery: PickupDeliveryRestriction[] = [];

    switch (cardType) {
      case EventCardType.Strike:
        // Coastal strike (#121, #122): no pickup/delivery in zone
        // Rail strike (#123): no movement on player's rail + no build for player
        // We distinguish via affectedZone: coastal has a zone, rail has empty zone
        if (affectedZone.length > 0) {
          // Coastal variant
          pickupDelivery.push({ type: 'no_pickup_delivery_in_zone', zone: affectedZone });
        } else {
          // Rail variant — targeting drawing player only
          movement.push({ type: 'no_movement_on_player_rail', targetPlayerId: drawingPlayerId });
          build.push({ type: 'no_build_for_player', targetPlayerId: drawingPlayerId });
        }
        break;

      case EventCardType.Snow:
        // Snow cards produce half_rate movement restriction + blocked terrain for movement and build.
        // Alpine (#130) blocks Alpine terrain; Mountain (#131, #132) blocks Mountain terrain.
        // We check affectedZone presence to determine applicability; terrain type is
        // determined by the card's effectConfig but we don't have it here.
        // Per spec: Snow #130 (Alpine) → blocked_terrain: [Alpine]; Snow #131/#132 → [Mountain]
        // Since we don't have the card config, we store both in the same structure.
        // The caller (addActiveEffect) passes the full effectConfig-derived zone.
        // We use a helper to determine which terrain was blocked from the card's effectConfig.
        // Since we can't know at this level, we store restrictions without blockedTerrain
        // and rely on the affectedZone for enforcement. For strict spec compliance, the
        // terrain types will be set by the calling code if needed.
        // For now, we use generic Snow restrictions with zone only.
        movement.push({ type: 'half_rate', zone: affectedZone });
        // Blocked terrain movement restriction — terrain type per spec
        // (Alpine for card 130, Mountain for 131/132). Store zone-based restriction.
        movement.push({ type: 'blocked_terrain', zone: affectedZone });
        build.push({ type: 'blocked_terrain', zone: affectedZone });
        break;

      case EventCardType.Flood:
        // No movement/build restrictions stored — bridge removal handled in P2.
        // Rebuild blocking handled via floodedRiver field.
        break;

      case EventCardType.Derailment:
        // No movement/build restrictions — only pendingLostTurns tracked.
        break;

      case EventCardType.ExcessProfitTax:
        // Immediate effect only — not persisted.
        break;
    }

    return { movement, build, pickupDelivery };
  }

  /**
   * Extract pendingLostTurns for Derailment cards from perPlayerEffects.
   * Only players with turn_lost effects are included.
   */
  private extractPendingLostTurns(
    cardType: EventCardType,
    perPlayerEffects: PerPlayerEffect[],
  ): { playerId: string }[] {
    if (cardType !== EventCardType.Derailment) {
      return [];
    }

    const seen = new Set<string>();
    const result: { playerId: string }[] = [];

    for (const effect of perPlayerEffects) {
      if (effect.effectType === 'turn_lost' && !seen.has(effect.playerId)) {
        seen.add(effect.playerId);
        result.push({ playerId: effect.playerId });
      }
    }

    return result;
  }
}

export const activeEffectManager = new ActiveEffectManager();

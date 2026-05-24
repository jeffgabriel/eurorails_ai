/**
 * EventLogger — Append-only NDJSON writer for event-card lifecycle events.
 *
 * JIRA-262: Per-game `logs/events-{gameId}.ndjson` capturing every event-card
 * draw / expire / consume / flood-removal / flood-rebuild as it happens.
 * Companion to the per-turn `logs/game-{gameId}.ndjson` snapshot in
 * GameLogger — that file tells you WHAT was active each turn; this file tells
 * you the timeline of WHEN events fired and which players were affected.
 *
 * Together they let post-hoc analysis answer "how many turns did Player X
 * lose to Derailment in game Y, and which delivery was blocked by the
 * Coastal Strike active in T29-T31?"
 */

import { mkdirSync, appendFile } from 'fs';
import { join } from 'path';
import type { TrackSegment } from '../../../shared/types/GameTypes';

const LOGS_DIR = join(process.cwd(), 'logs');

function ensureDir(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Lifecycle phase of an event-card record.
 *
 * - `drawn`: a player drew an Event card and the corresponding ActiveEffect
 *   was added to `games.active_event`. Includes the full restrictions/zone.
 * - `expired`: ActiveEffectManager.cleanupExpiredEffects removed an effect
 *   at the end of the drawing player's next turn (or the configured
 *   duration). Carries the cardIds that expired.
 * - `consumed`: ActiveEffectManager.consumeLostTurn removed a player's
 *   pendingLostTurns entry — the player skipped their turn this round.
 * - `flood-segments-removed`: TrackService.removeSegmentsCrossingRiver
 *   erased segments from a player's network as a Flood side effect.
 * - `flood-rebuild`: a previously-removed Flood segment was rebuilt by the
 *   bot during a subsequent Phase B BuildTrack.
 */
export type EventLogPhase =
  | 'drawn'
  | 'expired'
  | 'consumed'
  | 'flood-segments-removed'
  | 'flood-rebuild';

export interface EventLogEntry {
  /** ISO 8601 UTC */
  timestamp: string;
  /** The turn number on the drawing/affected player's turn counter when this event fired. */
  turn: number;
  phase: EventLogPhase;

  /** Card identifier (e.g. 121 = Strike#1). Always present on drawn / expired. */
  cardId?: number;
  /** Strike | Snow | Flood | Derailment — string for forward-compat. */
  cardType?: string;
  /** Player who drew the event card. */
  drawingPlayerId?: string;
  drawingPlayerIndex?: number;

  /** drawn: list of milepost keys affected. */
  affectedZone?: string[];
  /** drawn: short summary of the restrictions (e.g. "no_pickup_delivery_in_zone"). */
  restrictionTypes?: string[];
  /** drawn: which players have a pending lost turn from this card (Derailment only). */
  pendingLostTurnPlayerIds?: string[];
  /** drawn: river name (Flood only). */
  floodedRiver?: string;
  /** drawn: turn number after which this effect expires (drawing player's next turn end). */
  expiresAfterTurnNumber?: number;

  /** expired: cardIds that expired together (cleanup may batch). */
  expiredCardIds?: number[];

  /** consumed: which player's pendingLostTurns entry was consumed. */
  consumedPlayerId?: string;

  /** flood-segments-removed: which player's track was affected and how many segments. */
  affectedPlayerId?: string;
  segmentCount?: number;
  segments?: TrackSegment[];

  /** flood-rebuild: which segment was rebuilt. */
  rebuiltSegment?: TrackSegment;

  /** Free-form note for unusual cases — kept loose to avoid frequent schema bumps. */
  note?: string;
}

/**
 * Append an event entry to the game's events NDJSON file.
 * Best-effort: errors are logged but never thrown — observability must not
 * break the game loop.
 */
export function appendEvent(gameId: string, entry: EventLogEntry): void {
  try {
    ensureDir();
    const filePath = join(LOGS_DIR, `events-${gameId}.ndjson`);
    const line = JSON.stringify(entry) + '\n';
    appendFile(filePath, line, 'utf8', (err) => {
      if (err) {
        console.error(`[EventLogger] Failed to write event log for game ${gameId}:`, err.message);
      }
    });
  } catch (err) {
    console.error(`[EventLogger] Failed to write event log for game ${gameId}:`, err instanceof Error ? err.message : err);
  }
}

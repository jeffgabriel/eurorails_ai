/**
 * Shared test fixtures and helpers for AI pipeline tests.
 * Provides factory functions for creating test data.
 */

import { WorldSnapshot } from '../../../ai/types';
import {
  TrainType,
  TerrainType,
  TrackSegment,
  GridPoint,
} from '../../../../shared/types/GameTypes';
import { LoadType } from '../../../../shared/types/LoadTypes';
import { DemandCard } from '../../../../shared/types/DemandCard';

/**
 * Create a GridPoint for testing.
 */
export function makeGridPoint(
  row: number,
  col: number,
  terrain: TerrainType,
  cityName?: string,
): GridPoint {
  return {
    id: `${row}-${col}`,
    x: col * 50,
    y: row * 50,
    row,
    col,
    terrain,
    city: cityName
      ? { type: terrain, name: cityName, availableLoads: [] }
      : undefined,
  };
}

/**
 * Create a TrackSegment for testing.
 */
export function makeSegment(
  fromRow: number,
  fromCol: number,
  fromTerrain: TerrainType,
  toRow: number,
  toCol: number,
  toTerrain: TerrainType,
  cost: number,
): TrackSegment {
  return {
    from: { x: fromCol * 50, y: fromRow * 50, row: fromRow, col: fromCol, terrain: fromTerrain },
    to: { x: toCol * 50, y: toRow * 50, row: toRow, col: toCol, terrain: toTerrain },
    cost,
  };
}

/**
 * Create a WorldSnapshot with sensible defaults, overridable per test.
 */
export function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    gameId: 'test-game',
    botPlayerId: 'bot-1',
    botUserId: 'bot-user-1',
    gamePhase: 'active',
    turnBuildCostSoFar: 0,
    position: { x: 50, y: 50, row: 1, col: 1 },
    money: 50,
    debtOwed: 0,
    trainType: TrainType.Freight,
    remainingMovement: 9,
    carriedLoads: [],
    demandCards: [],
    trackSegments: [],
    connectedMajorCities: 0,
    opponents: [],
    allPlayerTracks: [],
    loadAvailability: new Map(),
    droppedLoads: new Map(),
    mapPoints: [],
    activeEvents: [],
    ...overrides,
  };
}

/**
 * Create a DemandCard for testing.
 */
export function makeDemandCard(
  id: number,
  demands: Array<{ city: string; resource: LoadType; payment: number }>,
): DemandCard {
  return { id, demands };
}

/**
 * Common test data constants.
 */
export const TEST_GAME_ID = 'test-game-001';
export const TEST_BOT_PLAYER_ID = 'bot-player-001';
export const TEST_BOT_USER_ID = 'bot-user-001';

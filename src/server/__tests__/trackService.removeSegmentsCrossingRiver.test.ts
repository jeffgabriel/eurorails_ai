/**
 * Unit tests for TrackService.removeSegmentsCrossingRiver and helpers.
 *
 * Uses a mocked DB client to avoid requiring a real PostgreSQL connection.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock DB ─────────────────────────────────────────────────────────────────
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
    connect: jest.fn<() => Promise<any>>(),
  },
}));

import { TrackService, getRiverEdgeKeys, segmentCrossesRiver } from '../services/trackService';
import { TerrainType, TrackSegment } from '../../shared/types/GameTypes';
import { PoolClient } from 'pg';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSegment(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  cost = 1
): TrackSegment {
  return {
    from: { row: fromRow, col: fromCol, x: 0, y: 0, terrain: TerrainType.Clear },
    to:   { row: toRow,   col: toCol,   x: 0, y: 0, terrain: TerrainType.Clear },
    cost,
  };
}

function makeMockClient(rows: any[]): { client: PoolClient; querySpy: jest.Mock } {
  const querySpy = jest.fn<() => Promise<any>>();
  // First call = SELECT FOR UPDATE (returns rows), subsequent calls = UPDATE
  querySpy.mockResolvedValueOnce({ rows });
  querySpy.mockResolvedValue({ rows: [] });

  const client = { query: querySpy } as unknown as PoolClient;
  return { client, querySpy };
}

// ── getRiverEdgeKeys ─────────────────────────────────────────────────────────

describe('getRiverEdgeKeys', () => {
  it('returns null for an unknown river', () => {
    expect(getRiverEdgeKeys('NonExistentRiver')).toBeNull();
  });

  it('returns a non-empty Set for a known river (Elbe)', () => {
    const keys = getRiverEdgeKeys('Elbe');
    expect(keys).not.toBeNull();
    expect(keys!.size).toBeGreaterThan(0);
  });

  it('returns canonical (order-independent) keys for Elbe', () => {
    const keys = getRiverEdgeKeys('Elbe');
    // rivers.json Elbe first edge: Start {Col:52, Row:30}, End {Row:53, Col:30}
    // After transposition fix: endRow = End.Col = 30, endCol = End.Row = 53
    // a = "30,52", b = "30,53"
    // r1 === r2 (both 30), c1(52) <= c2(53) → a comes first
    // canonical key = "30,52|30,53"
    const expectedKey = '30,52|30,53';
    expect(keys!.has(expectedKey)).toBe(true);
  });

  it('returns keys for Rhein (used in flood event cards)', () => {
    const keys = getRiverEdgeKeys('Rhein');
    expect(keys).not.toBeNull();
    expect(keys!.size).toBeGreaterThan(0);
  });
});

// ── segmentCrossesRiver ──────────────────────────────────────────────────────

describe('segmentCrossesRiver', () => {
  const riverEdgeKeys = new Set<string>(['10,20|11,20', '12,22|12,23']);

  it('returns true when segment from→to matches a river edge', () => {
    const seg = makeSegment(10, 20, 11, 20);
    expect(segmentCrossesRiver(seg, riverEdgeKeys)).toBe(true);
  });

  it('returns true when segment to→from matches a river edge (order-independent)', () => {
    const seg = makeSegment(11, 20, 10, 20);
    expect(segmentCrossesRiver(seg, riverEdgeKeys)).toBe(true);
  });

  it('returns false when segment does not match any river edge', () => {
    const seg = makeSegment(10, 20, 10, 21);
    expect(segmentCrossesRiver(seg, riverEdgeKeys)).toBe(false);
  });

  it('returns true for a second river edge', () => {
    const seg = makeSegment(12, 22, 12, 23);
    expect(segmentCrossesRiver(seg, riverEdgeKeys)).toBe(true);
  });
});

// ── removeSegmentsCrossingRiver ──────────────────────────────────────────────

describe('TrackService.removeSegmentsCrossingRiver', () => {
  const GAME_ID = 'game-uuid-1';
  const PLAYER_A = 'player-a-uuid';
  const PLAYER_B = 'player-b-uuid';

  // Elbe first edge: Row=30,Col=52 → Row=53,Col=30 is WRONG — let me use the known key.
  // From rivers.json Elbe: Start {Col:52, Row:30} End {Row:53, Col:30}
  // This means from (row=30, col=52) to (row=53, col=30)
  // Wait — let me re-read: Start.Row=30, Start.Col=52, End.Row=53, End.Col=30
  // Actually per the json: {"Start":{"Col":52,"Row":30},"End":{"Row":53,"Col":30}}
  // So from (30,52) to (53,30)
  // canonical: "30,52" vs "53,30" -> "30,52" < "53,30" -> "30,52|53,30"
  // Hmm that doesn't look like adjacent grid cells. Let me use a simpler approach.
  // Use a synthetic river edge key that I control.

  it('throws for an unknown river name', async () => {
    const { client } = makeMockClient([]);
    await expect(
      TrackService.removeSegmentsCrossingRiver(client, GAME_ID, 'UnknownRiver')
    ).rejects.toThrow('Unknown river: UnknownRiver');
  });

  it('returns empty array when no players have tracks in the game', async () => {
    const { client } = makeMockClient([]);
    const result = await TrackService.removeSegmentsCrossingRiver(client, GAME_ID, 'Elbe');
    expect(result).toEqual([]);
  });

  it('returns empty array when no segments cross the river', async () => {
    // A segment that does NOT cross the Elbe
    const seg = makeSegment(1, 1, 1, 2, 2);
    const { client } = makeMockClient([
      { player_id: PLAYER_A, segments: JSON.stringify([seg]), total_cost: 2 },
    ]);
    const result = await TrackService.removeSegmentsCrossingRiver(client, GAME_ID, 'Elbe');
    expect(result).toEqual([]);
  });

  it('removes segments that cross the river and recomputes total_cost', async () => {
    // Build a crossing segment using an actual Elbe edge from rivers.json
    // Elbe edge 1: Start {Col:52, Row:30} End {Row:53, Col:30} → BUT wait,
    // getRiverEdgeKeys reads Start.Row and Start.Col:
    // edge.Start.Row=30, edge.Start.Col=52 → a = "30,52"
    // edge.End.Row=53, edge.End.Col=30 → b = "53,30"
    // canonical key: "30,52" vs "53,30" → strcmp("30,52","53,30") → "3" < "5" → a first
    // key = "30,52|53,30"
    // But are (30,52) and (53,30) really adjacent on a hex grid? That seems wrong.
    // The JSON may have a different meaning. Let me just verify with getRiverEdgeKeys.
    const elbeKeys = getRiverEdgeKeys('Elbe')!;
    // Take the first key and build a crossing segment from it
    const firstKey = Array.from(elbeKeys)[0];
    const [fromPart, toPart] = firstKey.split('|');
    const [fromRow, fromCol] = fromPart.split(',').map(Number);
    const [toRow, toCol] = toPart.split(',').map(Number);

    const crossingSeg = makeSegment(fromRow, fromCol, toRow, toCol, 3);
    const safeSegment = makeSegment(1, 1, 1, 2, 2);

    const { client, querySpy } = makeMockClient([
      {
        player_id: PLAYER_A,
        segments: JSON.stringify([crossingSeg, safeSegment]),
        total_cost: 5,
      },
    ]);

    const result = await TrackService.removeSegmentsCrossingRiver(client, GAME_ID, 'Elbe');

    expect(result).toHaveLength(1);
    expect(result[0].playerId).toBe(PLAYER_A);
    expect(result[0].removedCount).toBe(1);
    expect(result[0].newTotalCost).toBe(2); // only safeSegment remains

    // Verify UPDATE was called with correct data
    const allCalls = querySpy.mock.calls as unknown as Array<[string, unknown[]]>;
    const updateCall = allCalls.find(([sql]) => sql.includes('UPDATE player_tracks'));
    expect(updateCall).toBeDefined();
    const updatedSegments = JSON.parse(updateCall![1][0] as string) as TrackSegment[];
    expect(updatedSegments).toHaveLength(1);
    expect(updatedSegments[0].from.row).toBe(safeSegment.from.row);
  });

  it('handles player with all segments crossing the river (removes all)', async () => {
    const elbeKeys = getRiverEdgeKeys('Elbe')!;
    const [key1, key2] = Array.from(elbeKeys).slice(0, 2);
    const parseKey = (k: string) => {
      const [fromPart, toPart] = k.split('|');
      const [fr, fc] = fromPart.split(',').map(Number);
      const [tr, tc] = toPart.split(',').map(Number);
      return { fr, fc, tr, tc };
    };
    const { fr: fr1, fc: fc1, tr: tr1, tc: tc1 } = parseKey(key1);
    const { fr: fr2, fc: fc2, tr: tr2, tc: tc2 } = parseKey(key2);

    const seg1 = makeSegment(fr1, fc1, tr1, tc1, 2);
    const seg2 = makeSegment(fr2, fc2, tr2, tc2, 3);

    const { client, querySpy } = makeMockClient([
      {
        player_id: PLAYER_A,
        segments: JSON.stringify([seg1, seg2]),
        total_cost: 5,
      },
    ]);

    const result = await TrackService.removeSegmentsCrossingRiver(client, GAME_ID, 'Elbe');

    expect(result).toHaveLength(1);
    expect(result[0].playerId).toBe(PLAYER_A);
    expect(result[0].removedCount).toBe(2);
    expect(result[0].newTotalCost).toBe(0);

    const allCalls2 = querySpy.mock.calls as unknown as Array<[string, unknown[]]>;
    const updateCall = allCalls2.find(([sql]) => sql.includes('UPDATE player_tracks'));
    const updatedSegments = JSON.parse(updateCall![1][0] as string) as TrackSegment[];
    expect(updatedSegments).toHaveLength(0);
  });

  it('only modifies players with crossing segments, leaves others unchanged', async () => {
    const elbeKeys = getRiverEdgeKeys('Elbe')!;
    const firstKey = Array.from(elbeKeys)[0];
    const [fromPart, toPart] = firstKey.split('|');
    const [fromRow, fromCol] = fromPart.split(',').map(Number);
    const [toRow, toCol] = toPart.split(',').map(Number);

    const crossingSeg = makeSegment(fromRow, fromCol, toRow, toCol, 4);
    const safeSeg = makeSegment(5, 5, 5, 6, 2);

    // querySpy needs to handle 1 SELECT and 1 UPDATE (for playerA only)
    const querySpy = jest.fn<() => Promise<any>>();
    querySpy.mockResolvedValueOnce({
      rows: [
        { player_id: PLAYER_A, segments: JSON.stringify([crossingSeg]), total_cost: 4 },
        { player_id: PLAYER_B, segments: JSON.stringify([safeSeg]), total_cost: 2 },
      ],
    });
    querySpy.mockResolvedValue({ rows: [] });

    const client = { query: querySpy } as unknown as PoolClient;
    const result = await TrackService.removeSegmentsCrossingRiver(client, GAME_ID, 'Elbe');

    // Only player A should be in results
    expect(result).toHaveLength(1);
    expect(result[0].playerId).toBe(PLAYER_A);
    expect(result[0].removedCount).toBe(1);

    // Only one UPDATE should have fired (for player A)
    const updateCalls = (querySpy.mock.calls as unknown as Array<[string, ...any[]]>).filter(
      ([sql]) => sql.includes('UPDATE player_tracks')
    );
    expect(updateCalls).toHaveLength(1);
    // The UPDATE should be for player A (params[3] = playerId)
    const updateParams = updateCalls[0]![1] as unknown[];
    expect(updateParams).toContain(PLAYER_A);
  });

  it('handles segments stored as a parsed object (not string) from JSONB', async () => {
    const elbeKeys = getRiverEdgeKeys('Elbe')!;
    const firstKey = Array.from(elbeKeys)[0];
    const [fromPart, toPart] = firstKey.split('|');
    const [fromRow, fromCol] = fromPart.split(',').map(Number);
    const [toRow, toCol] = toPart.split(',').map(Number);

    const crossingSeg = makeSegment(fromRow, fromCol, toRow, toCol, 3);

    // Simulate pg returning JSONB as a parsed object (not a string)
    const { client } = makeMockClient([
      { player_id: PLAYER_A, segments: [crossingSeg], total_cost: 3 },
    ]);

    const result = await TrackService.removeSegmentsCrossingRiver(client, GAME_ID, 'Elbe');
    expect(result).toHaveLength(1);
    expect(result[0].removedCount).toBe(1);
  });
});

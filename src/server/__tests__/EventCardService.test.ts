/**
 * Unit tests for EventCardService.
 *
 * Mocks the DB pool, AreaOfEffectService, and TrackService to focus on:
 * - Transaction management (commit/rollback on error, external client passthrough)
 * - Dispatch logic for each EventCardType
 * - Per-handler result shapes
 * - Concurrency: SELECT FOR UPDATE calls made on the right rows
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock DB ──────────────────────────────────────────────────────────────────
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
    connect: jest.fn<() => Promise<any>>(),
  },
}));

// ── Mock AreaOfEffectService ─────────────────────────────────────────────────
jest.mock('../services/AreaOfEffectService', () => ({
  AreaOfEffectService: {
    getCoastalMileposts: jest.fn<() => Set<string>>(),
    getZoneAroundCity: jest.fn<() => Set<string>>(),
    getPlayersInZone: jest.fn<() => Promise<any>>(),
    computeAffectedZone: jest.fn<() => Set<string>>(),
    getTrackSegmentsInZone: jest.fn<() => Promise<any>>(),
    findRiverCrossingSegments: jest.fn<() => Promise<any>>(),
  },
}));

// ── Mock TrackService ────────────────────────────────────────────────────────
jest.mock('../services/trackService', () => ({
  TrackService: {
    removeSegmentsCrossingRiver: jest.fn<() => Promise<any>>(),
    getAllTracks: jest.fn<() => Promise<any>>(),
  },
  getRiverEdgeKeys: jest.fn<() => Set<string> | null>(),
  segmentCrossesRiver: jest.fn<() => boolean>(),
}));

import { EventCardService } from '../services/EventCardService';
import { AreaOfEffectService } from '../services/AreaOfEffectService';
import { TrackService } from '../services/trackService';
import { db } from '../db/index';
import {
  EventCard,
  EventCardType,
} from '../../shared/types/EventCard';
import { PoolClient } from 'pg';

const mockAoE = AreaOfEffectService as unknown as {
  getCoastalMileposts: jest.Mock<() => any>;
  getZoneAroundCity: jest.Mock<() => any>;
  getPlayersInZone: jest.Mock<() => Promise<any>>;
};
const mockTrack = TrackService as unknown as {
  removeSegmentsCrossingRiver: jest.Mock<() => Promise<any>>;
};
const mockDb = db as unknown as {
  query: jest.Mock<() => Promise<any>>;
  connect: jest.Mock<() => Promise<any>>;
};

// ── Test fixtures ─────────────────────────────────────────────────────────────

const GAME_ID = 'game-uuid-1';
const DRAWING_PLAYER = 'player-uuid-drawing';
const OTHER_PLAYER = 'player-uuid-other';

function makeCoastalCard(): EventCard {
  return {
    id: 121,
    type: EventCardType.Strike,
    title: 'Coastal Strike!',
    description: 'No pickup/delivery within 3 mileposts of coast',
    effectConfig: { type: EventCardType.Strike, variant: 'coastal', coastalRadius: 3 },
  };
}

function makeRailCard(): EventCard {
  return {
    id: 123,
    type: EventCardType.Strike,
    title: 'Rail Strike!',
    description: 'Drawing player cannot move on own track',
    effectConfig: { type: EventCardType.Strike, variant: 'rail', affectsDrawingPlayerOnly: true },
  };
}

function makeDerailmentCard(): EventCard {
  return {
    id: 125,
    type: EventCardType.Derailment,
    title: 'Derailment!',
    description: 'Trains near Paris or Bruxelles lose 1 turn and 1 load',
    effectConfig: { type: EventCardType.Derailment, cities: ['Paris', 'Bruxelles'], radius: 3 },
  };
}

function makeSnowCard(): EventCard {
  return {
    id: 131,
    type: EventCardType.Snow,
    title: 'Snow!',
    description: 'Half-rate movement near Munchen (radius 4)',
    effectConfig: {
      type: EventCardType.Snow,
      centerCity: 'Munchen',
      radius: 4,
      blockedTerrain: [2, 3], // Mountain, Alpine
    },
  };
}

function makeFloodCard(): EventCard {
  return {
    id: 133,
    type: EventCardType.Flood,
    title: 'Flood!',
    description: 'Bridges crossing the Rhein are erased',
    effectConfig: { type: EventCardType.Flood, river: 'Rhein' },
  };
}

function makeTaxCard(): EventCard {
  return {
    id: 124,
    type: EventCardType.ExcessProfitTax,
    title: 'Excess Profit Tax!',
    description: 'All players pay tax',
    effectConfig: {
      type: EventCardType.ExcessProfitTax,
      brackets: [
        { threshold: 200, tax: 50 },
        { threshold: 150, tax: 40 },
        { threshold: 100, tax: 30 },
        { threshold: 50, tax: 20 },
        { threshold: 0, tax: 0 },
      ],
    },
  };
}

/** Build a mock PoolClient that records SQL calls */
function makeMockClient(): {
  client: PoolClient;
  querySpy: jest.Mock;
  beginCount: () => number;
  commitCount: () => number;
  rollbackCount: () => number;
} {
  const querySpy = jest.fn<() => Promise<any>>();
  querySpy.mockResolvedValue({ rows: [] });
  const releaseSpy = jest.fn<() => void>();

  const client = { query: querySpy, release: releaseSpy } as unknown as PoolClient;

  return {
    client,
    querySpy,
    beginCount: () =>
      (querySpy.mock.calls as unknown as Array<[string, ...any[]]>).filter(([sql]) =>
        sql.trim() === 'BEGIN',
      ).length,
    commitCount: () =>
      (querySpy.mock.calls as unknown as Array<[string, ...any[]]>).filter(([sql]) =>
        sql.trim() === 'COMMIT',
      ).length,
    rollbackCount: () =>
      (querySpy.mock.calls as unknown as Array<[string, ...any[]]>).filter(([sql]) =>
        sql.trim() === 'ROLLBACK',
      ).length,
  };
}

// ── Transaction management ────────────────────────────────────────────────────

describe('EventCardService transaction management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens its own transaction when no external client provided', async () => {
    const { client, querySpy, beginCount, commitCount } = makeMockClient();
    // db.connect() returns the mock client
    mockDb.connect.mockResolvedValue(client);

    // Flood card — no AoE zone needed
    mockTrack.removeSegmentsCrossingRiver.mockResolvedValue([]);
    // buildDescriptor needs player rows
    querySpy.mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 3 }] };
      }
      return { rows: [] };
    });

    await EventCardService.processEventCard(GAME_ID, makeFloodCard(), DRAWING_PLAYER);

    expect(beginCount()).toBe(1);
    expect(commitCount()).toBe(1);
    // client.release should have been called once
    expect((client as any).release).toHaveBeenCalled();
  });

  it('rolls back on handler error', async () => {
    const { client, rollbackCount } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    // Flood handler will throw
    mockTrack.removeSegmentsCrossingRiver.mockRejectedValue(new Error('DB error'));

    await expect(
      EventCardService.processEventCard(GAME_ID, makeFloodCard(), DRAWING_PLAYER),
    ).rejects.toThrow('DB error');

    expect(rollbackCount()).toBe(1);
  });

  it('does NOT begin/commit when an external client is provided', async () => {
    const { client, beginCount, commitCount } = makeMockClient();

    mockTrack.removeSegmentsCrossingRiver.mockResolvedValue([]);
    // Make querySpy return player rows for buildDescriptor
    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 2 }] };
      }
      return { rows: [] };
    });

    await EventCardService.processEventCard(GAME_ID, makeFloodCard(), DRAWING_PLAYER, client);

    expect(beginCount()).toBe(0);
    expect(commitCount()).toBe(0);
    expect(mockDb.connect).not.toHaveBeenCalled();
  });
});

// ── Strike (coastal) ──────────────────────────────────────────────────────────

describe('EventCardService: Strike (coastal)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('produces no_pickup_delivery for players in coastal zone', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    const coastalZone = new Set(['10,5', '11,5', '12,6']);
    mockAoE.getCoastalMileposts.mockReturnValue(coastalZone);
    mockAoE.getPlayersInZone.mockResolvedValue([
      { playerId: DRAWING_PLAYER, name: 'Alice', money: 100, loads: [], positionRow: 10, positionCol: 5 },
      { playerId: OTHER_PLAYER, name: 'Bob', money: 80, loads: [], positionRow: 30, positionCol: 20 },
    ]);

    // buildDescriptor
    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 1 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeCoastalCard(), DRAWING_PLAYER, client,
    );

    expect(result.cardType).toBe(EventCardType.Strike);
    expect(result.perPlayerEffects).toHaveLength(2);
    expect(result.perPlayerEffects.every(e => e.effectType === 'no_pickup_delivery')).toBe(true);
    expect(result.floodSegmentsRemoved).toHaveLength(0);
    expect(result.affectedZone).toHaveLength(3);
  });

  it('produces empty perPlayerEffects when no players in coastal zone', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    mockAoE.getCoastalMileposts.mockReturnValue(new Set(['1,1']));
    mockAoE.getPlayersInZone.mockResolvedValue([]);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 1 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeCoastalCard(), DRAWING_PLAYER, client,
    );

    expect(result.perPlayerEffects).toHaveLength(0);
  });
});

// ── Strike (rail) ─────────────────────────────────────────────────────────────

describe('EventCardService: Strike (rail)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('produces no_movement for drawing player only', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 1 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeRailCard(), DRAWING_PLAYER, client,
    );

    expect(result.perPlayerEffects).toHaveLength(1);
    expect(result.perPlayerEffects[0].playerId).toBe(DRAWING_PLAYER);
    expect(result.perPlayerEffects[0].effectType).toBe('no_movement');
    expect(result.affectedZone).toHaveLength(0);
  });
});

// ── Derailment ────────────────────────────────────────────────────────────────

describe('EventCardService: Derailment', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('removes first load from affected players and produces turn_lost + load_lost', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    const derailZone = new Set(['29,32', '29,31']);
    mockAoE.getZoneAroundCity.mockReturnValue(derailZone);
    mockAoE.getPlayersInZone.mockResolvedValue([
      { playerId: DRAWING_PLAYER, loads: ['coal', 'steel'], positionRow: 29, positionCol: 32 },
    ]);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('FOR UPDATE')) {
        return {
          rows: [{ id: DRAWING_PLAYER, loads: ['coal', 'steel'] }],
        };
      }
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 2 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeDerailmentCard(), DRAWING_PLAYER, client,
    );

    // Should have load_lost + turn_lost for the affected player
    const effects = result.perPlayerEffects.filter(e => e.playerId === DRAWING_PLAYER);
    expect(effects.some(e => e.effectType === 'load_lost')).toBe(true);
    expect(effects.some(e => e.effectType === 'turn_lost')).toBe(true);

    // UPDATE should have been called to remove first load
    const allCalls = (client.query as jest.Mock).mock.calls as unknown as Array<[string, unknown[]]>;
    const updateCall = allCalls.find(([sql]) => sql.includes('UPDATE players SET loads'));
    expect(updateCall).toBeDefined();
    // New loads array should be ['steel'] (removed 'coal')
    const newLoads = updateCall![1][0] as string[];
    expect(newLoads).toEqual(['steel']);
  });

  it('produces only turn_lost when player has no loads', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    mockAoE.getZoneAroundCity.mockReturnValue(new Set(['29,32']));
    mockAoE.getPlayersInZone.mockResolvedValue([
      { playerId: DRAWING_PLAYER, loads: [], positionRow: 29, positionCol: 32 },
    ]);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('FOR UPDATE')) {
        return { rows: [{ id: DRAWING_PLAYER, loads: [] }] };
      }
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 1 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeDerailmentCard(), DRAWING_PLAYER, client,
    );

    const effects = result.perPlayerEffects;
    expect(effects.some(e => e.effectType === 'turn_lost')).toBe(true);
    expect(effects.some(e => e.effectType === 'load_lost')).toBe(false);
  });
});

// ── Snow ──────────────────────────────────────────────────────────────────────

describe('EventCardService: Snow', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('produces speed_halved for players in zone', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    const snowZone = new Set(['40,55', '41,56']);
    const blockedZone = new Set(['40,55']); // only one mountain in zone
    mockAoE.getZoneAroundCity
      .mockReturnValueOnce(snowZone)  // full zone
      .mockReturnValueOnce(blockedZone);  // blocked terrain subset

    mockAoE.getPlayersInZone.mockResolvedValue([
      { playerId: DRAWING_PLAYER, positionRow: 40, positionCol: 55 },
    ]);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('FOR UPDATE')) return { rows: [{ id: DRAWING_PLAYER }] };
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 1 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeSnowCard(), DRAWING_PLAYER, client,
    );

    expect(result.perPlayerEffects).toHaveLength(1);
    expect(result.perPlayerEffects[0].effectType).toBe('speed_halved');
    expect(result.affectedZone).toEqual(Array.from(snowZone));
  });
});

// ── Flood ─────────────────────────────────────────────────────────────────────

describe('EventCardService: Flood', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('removes river-crossing segments and returns track_erased effects', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    mockTrack.removeSegmentsCrossingRiver.mockResolvedValue([
      { playerId: DRAWING_PLAYER, removedCount: 2, newTotalCost: 8 },
      { playerId: OTHER_PLAYER, removedCount: 1, newTotalCost: 3 },
    ]);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 1 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeFloodCard(), DRAWING_PLAYER, client,
    );

    expect(result.floodSegmentsRemoved).toHaveLength(2);
    expect(result.perPlayerEffects).toHaveLength(2);
    expect(result.perPlayerEffects.every(e => e.effectType === 'track_erased')).toBe(true);

    const drawingEffect = result.perPlayerEffects.find(e => e.playerId === DRAWING_PLAYER);
    expect(drawingEffect?.amount).toBe(2);
  });

  it('returns empty arrays when no segments cross river', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    mockTrack.removeSegmentsCrossingRiver.mockResolvedValue([]);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('current_turn_number')) {
        return { rows: [{ id: DRAWING_PLAYER, current_turn_number: 1 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeFloodCard(), DRAWING_PLAYER, client,
    );

    expect(result.floodSegmentsRemoved).toHaveLength(0);
    expect(result.perPlayerEffects).toHaveLength(0);
  });
});

// ── Excess Profit Tax ─────────────────────────────────────────────────────────

describe('EventCardService: ExcessProfitTax', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('deducts correct tax bracket amount from each player', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('FOR UPDATE')) {
        return {
          rows: [
            { id: 'p1', money: 210 }, // bracket: >= 200 → tax 50
            { id: 'p2', money: 160 }, // bracket: >= 150 → tax 40
            { id: 'p3', money: 30 },  // bracket: >= 0 → tax 0
          ],
        };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeTaxCard(), DRAWING_PLAYER, client,
    );

    const p1Effect = result.perPlayerEffects.find(e => e.playerId === 'p1');
    const p2Effect = result.perPlayerEffects.find(e => e.playerId === 'p2');
    const p3Effect = result.perPlayerEffects.find(e => e.playerId === 'p3');

    expect(p1Effect?.amount).toBe(50);
    expect(p2Effect?.amount).toBe(40);
    expect(p3Effect).toBeUndefined(); // no tax for bracket tax=0

    // Verify UPDATE calls
    const allCalls = (client.query as jest.Mock).mock.calls as unknown as Array<[string, unknown[]]>;
    const updateCalls = allCalls.filter(([sql]) => sql.includes('UPDATE players SET money'));
    expect(updateCalls).toHaveLength(2); // p1 and p2 only

    const p1Update = updateCalls.find(call => call[1][1] === 'p1');
    expect(p1Update?.[1][0]).toBe(160); // 210 - 50

    const p2Update = updateCalls.find(call => call[1][1] === 'p2');
    expect(p2Update?.[1][0]).toBe(120); // 160 - 40
  });

  it('does not go below zero money', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('FOR UPDATE')) {
        return { rows: [{ id: 'p1', money: 40 }] }; // threshold 0, tax 0
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeTaxCard(), DRAWING_PLAYER, client,
    );

    // No tax because bracket at threshold 0 has tax 0
    expect(result.perPlayerEffects).toHaveLength(0);
  });

  it('has no persistentEffectDescriptor (one-shot event)', async () => {
    const { client } = makeMockClient();
    mockDb.connect.mockResolvedValue(client);

    (client.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      if ((sql as string).includes('FOR UPDATE')) {
        return { rows: [{ id: 'p1', money: 10 }] };
      }
      return { rows: [] };
    });

    const result = await EventCardService.processEventCard(
      GAME_ID, makeTaxCard(), DRAWING_PLAYER, client,
    );

    expect(result.persistentEffectDescriptor).toBeUndefined();
  });
});

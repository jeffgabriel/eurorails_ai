import { createServer } from 'http';

const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
const mockIoInstance = {
  use: jest.fn(),
  on: jest.fn(),
  to: mockTo,
  close: jest.fn(),
};

jest.mock('socket.io', () => {
  return {
    Server: jest.fn(() => mockIoInstance),
  };
});

const mockDbQuery = jest.fn();
jest.mock('../db', () => {
  return {
    db: {
      query: (...args: any[]) => mockDbQuery(...args),
    },
  };
});

describe('socketService sequencing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emitStatePatch should allocate a monotonic serverSeq from DB and include it in the payload', async () => {
    const { initializeSocketIO, emitStatePatch } = await import('../services/socketService');

    // init io singleton
    initializeSocketIO(createServer());

    mockDbQuery.mockResolvedValueOnce({ rows: [{ server_seq: 1 }] });

    await emitStatePatch('game-1', { players: [] } as any);

    expect(mockTo).toHaveBeenCalledWith('game-1');
    expect(mockEmit).toHaveBeenCalledWith('state:patch', {
      patch: { players: [] },
      serverSeq: 1,
    });
  });
});



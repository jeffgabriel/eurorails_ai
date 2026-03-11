/**
 * Mock for pg database (db.query and db.connect).
 * Returns no-op results by default. Tests can override via mockReturnValue.
 */

const mockClient = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  release: jest.fn(),
};

export const mockDb = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn().mockResolvedValue(mockClient),
};

export const mockDbClient = mockClient;

/**
 * Call this in jest.mock() to replace the real db module.
 * Usage:
 *   jest.mock('../../db/index', () => ({ db: require('../mocks/db.mock').mockDb }));
 */
export function resetDbMock(): void {
  mockDb.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockDbClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockDbClient.release.mockReset();
  mockDb.connect.mockReset().mockResolvedValue(mockClient);
}

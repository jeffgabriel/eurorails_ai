/**
 * Mock for Socket.IO (emitToGame and emitStatePatch from socketService).
 * No-op by default -- prevents real socket emissions during tests.
 */

export const mockEmitToGame = jest.fn();
export const mockEmitStatePatch = jest.fn().mockResolvedValue(undefined);

export function resetSocketMock(): void {
  mockEmitToGame.mockReset();
  mockEmitStatePatch.mockReset().mockResolvedValue(undefined);
}

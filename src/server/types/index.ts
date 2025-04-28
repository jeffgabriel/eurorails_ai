import { Session } from 'express-session';

declare module 'express-session' {
  interface SessionData {
    gameId: string;
  }
}

export interface GameState {
    // ... existing code ...
} 
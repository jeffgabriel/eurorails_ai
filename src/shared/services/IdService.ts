import { v4 as uuidv4 } from 'uuid';

const DEV_MODE = process.env.NODE_ENV === 'development';

export class IdService {
    private static gameCounter = 1;
    private static playerCounter = 1;

    static generateGameId(): string {
        if (DEV_MODE) {
            return `game${this.gameCounter++}`;
        }
        return uuidv4();
    }

    static generatePlayerId(): string {
        if (DEV_MODE) {
            return `player${this.playerCounter++}`;
        }
        return uuidv4();
    }

    // Reset counters - useful for testing and development
    static resetCounters(): void {
        if (DEV_MODE) {
            this.gameCounter = 1;
            this.playerCounter = 1;
        }
    }
} 
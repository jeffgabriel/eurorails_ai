import { v4 as uuidv4 } from 'uuid';

export class IdService {
    static generateGameId(): string {
        return uuidv4();
    }

    static generatePlayerId(): string {
        return uuidv4();
    }
} 
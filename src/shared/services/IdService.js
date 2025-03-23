import { v4 as uuidv4 } from 'uuid';
export class IdService {
    static generateGameId() {
        return uuidv4();
    }
    static generatePlayerId() {
        return uuidv4();
    }
}

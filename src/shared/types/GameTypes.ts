export enum PlayerColor {
    YELLOW = '#FFD700',  // Using a golden yellow for better visibility
    RED = '#FF0000',
    BLUE = '#0000FF',
    BLACK = '#000000',
    GREEN = '#008000',  // Using a darker green for better visibility
    BROWN = '#8B4513'   // Using saddle brown for better visibility
}

export interface Player {
    id: string;  // Add unique identifier for database
    name: string;
    color: string;  // Hex color code
    money: number;
    trainType: string;  // We'll expand this later with proper train types
}

export type GameStatus = 'setup' | 'initialBuild' | 'playing' | 'completed';

export interface Game {
    id: string;
    status: GameStatus;
    maxPlayers: number;
    currentPlayerIndex: number;
    winnerId?: string;
}

export type GamePhase = 'setup' | 'play' | 'end';

export interface GameState {
    id: string;  // Add unique identifier for the game
    players: Player[];
    currentPlayerIndex: number;
    gamePhase: GamePhase;
    maxPlayers: number;
}

export const INITIAL_PLAYER_MONEY = 50; // 50M ECU starting money 
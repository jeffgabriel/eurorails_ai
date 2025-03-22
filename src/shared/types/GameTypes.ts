export enum PlayerColor {
    RED = '#ff0000',
    BLUE = '#0000ff',
    GREEN = '#00ff00',
    YELLOW = '#ffff00',
    PURPLE = '#800080',
    ORANGE = '#ffa500'
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
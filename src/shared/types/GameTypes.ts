enum PlayerColor {
    YELLOW = '#FFD700',  // Using a golden yellow for better visibility
    RED = '#FF0000',
    BLUE = '#0000FF',
    BLACK = '#000000',
    GREEN = '#008000',  // Using a darker green for better visibility
    BROWN = '#8B4513'   // Using saddle brown for better visibility
}

interface Player {
    id: string;  // Add unique identifier for database
    name: string;
    color: string;  // Hex color code
    money: number;
    trainType: string;  // We'll expand this later with proper train types
}

type GameStatus = 'setup' | 'active' | 'completed';

interface Game {
    id: string;
    status: GameStatus;
    maxPlayers: number;
    currentPlayerIndex: number;
    winnerId?: string;
    createdAt: Date;
    updatedAt: Date;
}

interface GameState {
    id: string;  // Add unique identifier for the game
    players: Player[];
    currentPlayerIndex: number;
    status: GameStatus;
    maxPlayers: number;
}

const INITIAL_PLAYER_MONEY = 50; // 50M ECU starting money

export {
    PlayerColor,
    Player,
    GameStatus,
    Game,
    GameState,
    INITIAL_PLAYER_MONEY
}; 
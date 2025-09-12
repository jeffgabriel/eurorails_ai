import express, { Request, Response } from 'express';
import { LobbyService, CreateGameData } from '../services/lobbyService';
import {
  LobbyError,
  GameNotFoundError,
  GameFullError,
  GameAlreadyStartedError,
  InvalidJoinCodeError,
  NotGameCreatorError,
  InsufficientPlayersError
} from '../services/lobbyService';

const router = express.Router();

// Request/Response interfaces
interface CreateGameRequest {
  isPublic?: boolean;
  maxPlayers?: number;
}

interface JoinGameRequest {
  joinCode: string;
}

interface StartGameRequest {
  creatorUserId: string;
}

interface LeaveGameRequest {
  userId: string;
}

interface UpdatePresenceRequest {
  userId: string;
  isOnline: boolean;
}

// Helper function to handle lobby errors
function handleLobbyError(error: any, res: Response): void {
  console.error('Lobby API Error:', error);
  
  if (error instanceof LobbyError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
      details: error.message
    });
  } else if (error instanceof Error) {
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      details: error.message
    });
  } else {
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      details: 'Unknown error type'
    });
  }
}

// Helper function to validate required fields
function validateRequiredFields(fields: Record<string, any>, res: Response): boolean {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `${key} is required`,
        details: `Missing required field: ${key}`
      });
      return false;
    }
  }
  return true;
}

// Helper function to validate UUID format
function validateUUID(uuid: string, fieldName: string, res: Response): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(uuid)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `Invalid ${fieldName} format`,
      details: `${fieldName} must be a valid UUID`
    });
    return false;
  }
  return true;
}

// POST /api/lobby/games - Create a new game
router.post('/games', async (req: Request, res: Response) => {
  try {
    console.log('POST /api/lobby/games - Create game request:', req.body);
    
    const { isPublic, maxPlayers }: CreateGameRequest = req.body;
    const createdByUserId = req.body.createdByUserId || req.headers['x-user-id'] as string;
    
    // Validate required fields
    if (!validateRequiredFields({ createdByUserId }, res)) {
      return;
    }
    
    // Validate UUID format
    if (!validateUUID(createdByUserId, 'createdByUserId', res)) {
      return;
    }
    
    // Validate maxPlayers if provided
    if (maxPlayers !== undefined && (maxPlayers < 2 || maxPlayers > 6)) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'maxPlayers must be between 2 and 6',
        details: 'Invalid maxPlayers value'
      });
      return;
    }
    
    const gameData: CreateGameData = {
      createdByUserId,
      isPublic: isPublic || false,
      maxPlayers: maxPlayers || 6
    };
    
    const game = await LobbyService.createGame(gameData);
    
    console.log('Game created successfully:', game.id);
    
    res.status(201).json({
      game: {
        id: game.id,
        joinCode: game.joinCode,
        createdBy: game.createdBy,
        status: game.status,
        maxPlayers: game.maxPlayers,
        isPublic: game.isPublic,
        createdAt: game.createdAt
      }
    });
  } catch (error) {
    handleLobbyError(error, res);
  }
});

// POST /api/lobby/games/join - Join an existing game
router.post('/games/join', async (req: Request, res: Response) => {
  try {
    console.log('POST /api/lobby/games/join - Join game request:', req.body);
    
    const { joinCode }: JoinGameRequest = req.body;
    const userId = req.body.userId || req.headers['x-user-id'] as string;
    
    // Validate required fields
    if (!validateRequiredFields({ joinCode, userId }, res)) {
      return;
    }
    
    // Validate UUID format for userId
    if (!validateUUID(userId, 'userId', res)) {
      return;
    }
    
    // Validate join code format (8 characters, alphanumeric)
    if (!/^[A-Z0-9]{8}$/i.test(joinCode)) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid join code format',
        details: 'Join code must be 8 alphanumeric characters'
      });
      return;
    }
    
    const game = await LobbyService.joinGame(joinCode.toUpperCase(), userId);
    
    console.log('Player joined game successfully:', { gameId: game.id, userId });
    
    res.status(200).json({
      game: {
        id: game.id,
        joinCode: game.joinCode,
        createdBy: game.createdBy,
        status: game.status,
        maxPlayers: game.maxPlayers,
        isPublic: game.isPublic,
        createdAt: game.createdAt
      }
    });
  } catch (error) {
    handleLobbyError(error, res);
  }
});

// GET /api/lobby/games/:id - Get game information
router.get('/games/:id', async (req: Request, res: Response) => {
  try {
    console.log('GET /api/lobby/games/:id - Get game request:', req.params);
    
    const { id: gameId } = req.params;
    
    // Validate required fields
    if (!validateRequiredFields({ gameId }, res)) {
      return;
    }
    
    // Validate UUID format
    if (!validateUUID(gameId, 'gameId', res)) {
      return;
    }
    
    const game = await LobbyService.getGame(gameId);
    
    if (!game) {
      res.status(404).json({
        error: 'GAME_NOT_FOUND',
        message: 'Game not found',
        details: 'No game exists with the provided ID'
      });
      return;
    }
    
    console.log('Game retrieved successfully:', game.id);
    
    res.status(200).json({
      game: {
        id: game.id,
        joinCode: game.joinCode,
        createdBy: game.createdBy,
        status: game.status,
        maxPlayers: game.maxPlayers,
        isPublic: game.isPublic,
        createdAt: game.createdAt
      }
    });
  } catch (error) {
    handleLobbyError(error, res);
  }
});

// GET /api/lobby/games/:id/players - Get players in a game
router.get('/games/:id/players', async (req: Request, res: Response) => {
  try {
    console.log('GET /api/lobby/games/:id/players - Get game players request:', req.params);
    
    const { id: gameId } = req.params;
    
    // Validate required fields
    if (!validateRequiredFields({ gameId }, res)) {
      return;
    }
    
    // Validate UUID format
    if (!validateUUID(gameId, 'gameId', res)) {
      return;
    }
    
    const players = await LobbyService.getGamePlayers(gameId);
    
    console.log('Game players retrieved successfully:', { gameId, playerCount: players.length });
    
    res.status(200).json({
      players: players.map(player => ({
        id: player.id,
        userId: player.userId,
        name: player.name,
        color: player.color,
        isOnline: player.isOnline
      }))
    });
  } catch (error) {
    handleLobbyError(error, res);
  }
});

// POST /api/lobby/games/:id/start - Start a game
router.post('/games/:id/start', async (req: Request, res: Response) => {
  try {
    console.log('POST /api/lobby/games/:id/start - Start game request:', req.params, req.body);
    
    const { id: gameId } = req.params;
    const { creatorUserId }: StartGameRequest = req.body;
    const userId = creatorUserId || req.headers['x-user-id'] as string;
    
    // Validate required fields
    if (!validateRequiredFields({ gameId, userId }, res)) {
      return;
    }
    
    // Validate UUID format
    if (!validateUUID(gameId, 'gameId', res) || !validateUUID(userId, 'userId', res)) {
      return;
    }
    
    await LobbyService.startGame(gameId, userId);
    
    console.log('Game started successfully:', gameId);
    
    res.status(200).json({
      message: 'Game started successfully',
      gameId: gameId
    });
  } catch (error) {
    handleLobbyError(error, res);
  }
});

// POST /api/lobby/games/:id/leave - Leave a game
router.post('/games/:id/leave', async (req: Request, res: Response) => {
  try {
    console.log('POST /api/lobby/games/:id/leave - Leave game request:', req.params, req.body);
    
    const { id: gameId } = req.params;
    const { userId }: LeaveGameRequest = req.body;
    const userIdFromBody = userId || req.headers['x-user-id'] as string;
    
    // Validate required fields
    if (!validateRequiredFields({ gameId, userId: userIdFromBody }, res)) {
      return;
    }
    
    // Validate UUID format
    if (!validateUUID(gameId, 'gameId', res) || !validateUUID(userIdFromBody, 'userId', res)) {
      return;
    }
    
    await LobbyService.leaveGame(gameId, userIdFromBody);
    
    console.log('Player left game successfully:', { gameId, userId: userIdFromBody });
    
    res.status(200).json({
      message: 'Left game successfully',
      gameId: gameId
    });
  } catch (error) {
    handleLobbyError(error, res);
  }
});

// POST /api/lobby/players/presence - Update player online status
router.post('/players/presence', async (req: Request, res: Response) => {
  try {
    console.log('POST /api/lobby/players/presence - Update presence request:', req.body);
    
    const { userId, isOnline }: UpdatePresenceRequest = req.body;
    
    // Validate required fields
    if (!validateRequiredFields({ userId, isOnline }, res)) {
      return;
    }
    
    // Validate UUID format
    if (!validateUUID(userId, 'userId', res)) {
      return;
    }
    
    // Validate isOnline type
    if (typeof isOnline !== 'boolean') {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'isOnline must be a boolean',
        details: 'Invalid isOnline value type'
      });
      return;
    }
    
    await LobbyService.updatePlayerPresence(userId, isOnline);
    
    console.log('Player presence updated successfully:', { userId, isOnline });
    
    res.status(200).json({
      message: 'Player presence updated successfully',
      userId: userId,
      isOnline: isOnline
    });
  } catch (error) {
    handleLobbyError(error, res);
  }
});

// Health check endpoint
router.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    service: 'lobby-api',
    timestamp: new Date().toISOString()
  });
});

export default router;

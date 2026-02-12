import express, { Request, Response } from 'express';
import { LobbyService, CreateGameData, NotABotError, GameNotFoundError, NotGameCreatorError, GameAlreadyStartedError, GameFullError } from '../services/lobbyService';
import { BotSkillLevel, BotArchetype, BotConfig } from '../../shared/types/GameTypes';
import { asyncHandler } from '../middleware/errorHandler';
import { requestLogger } from '../middleware/requestLogger';
import { optionalAuth, authenticateToken, requireAuth } from '../middleware/authMiddleware';

// Extend the Request type to include requestId (needed for this file)
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const router = express.Router();

// Request/Response interfaces
interface CreateGameRequest {
  isPublic?: boolean;
  maxPlayers?: number;
  createdByUserId?: string;
  creatorColor?: string;
}

interface JoinGameRequest {
  joinCode: string;
  selectedColor?: string;
  // userId is no longer accepted from request body - must come from JWT token
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

interface DeleteGameRequest {
  mode: 'soft' | 'hard' | 'transfer';
  newOwnerUserId?: string;
}

interface BulkDeleteGamesRequest {
  gameIds: string[];
  mode: 'soft' | 'hard';
}

// GET /api/lobby/my-games - List games for current user
router.get('/my-games', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  logLobbyOperation('List my games request', { userId }, req);

  const result = await LobbyService.getMyGames(userId);

  res.status(200).json({
    success: true,
    data: result
  });
}));

// POST /api/lobby/games/:id/delete - Delete (soft/hard) or transfer ownership
router.post('/games/:id/delete', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id: gameId } = req.params;
  const userId = req.user!.id;
  const { mode, newOwnerUserId }: DeleteGameRequest = req.body;

  logLobbyOperation('Delete game request', { gameId, userId, mode, newOwnerUserId }, req);

  if (!validateRequiredFields({ mode }, res)) {
    return;
  }

  await LobbyService.deleteGame(gameId, userId, { mode, newOwnerUserId });

  res.status(200).json({
    success: true,
    message: 'Game deleted successfully'
  });
}));

// POST /api/lobby/games/bulk-delete - Bulk delete (soft/hard)
router.post('/games/bulk-delete', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { gameIds, mode }: BulkDeleteGamesRequest = req.body;

  logLobbyOperation('Bulk delete games request', { userId, count: gameIds?.length || 0, mode }, req);

  if (!validateRequiredFields({ gameIds, mode }, res)) {
    return;
  }

  if (!Array.isArray(gameIds) || gameIds.length === 0) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'gameIds must be a non-empty array',
      details: 'Invalid gameIds'
    });
    return;
  }

  await LobbyService.bulkDeleteGames(userId, { gameIds, mode });

  res.status(200).json({
    success: true,
    message: 'Games deleted successfully'
  });
}));

// Enhanced request logging for lobby operations
function logLobbyOperation(operation: string, data?: any, req?: Request): void {
  const requestId = req?.requestId || 'unknown';
  requestLogger.logApiOperation(operation, data, requestId);
}

// Helper function to validate required fields
function validateRequiredFields(fields: Record<string, any>, res: Response): boolean {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `Missing required field: ${key}`,
        details: `${key} is required`
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
router.post('/games', asyncHandler(async (req: Request, res: Response) => {
  const { isPublic, maxPlayers, createdByUserId, creatorColor }: CreateGameRequest = req.body;
  const userId = createdByUserId || req.headers['x-user-id'] as string;
  
  logLobbyOperation('Create game request', { isPublic, maxPlayers, userId, creatorColor }, req);
  
  // Validate required fields
  if (!validateRequiredFields({ userId }, res)) {
    return;
  }
  
  // Validate UUID format
  if (!validateUUID(userId, 'userId', res)) {
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
    createdByUserId: userId,
    maxPlayers: maxPlayers || 6,
    isPublic: isPublic || false,
    creatorColor: creatorColor
  };
  
  const game = await LobbyService.createGame(gameData);
  
  logLobbyOperation('Game created successfully', { 
    gameId: game.id, 
    joinCode: game.joinCode,
    createdBy: userId 
  }, req);
  
  res.status(201).json({
    success: true,
    data: game
  });
}));

// POST /api/lobby/games/join - Join an existing game
router.post('/games/join', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { joinCode, selectedColor }: JoinGameRequest = req.body;
  
  // Always get userId from authenticated JWT token - never trust request body or headers
  const user = req.user?.id;
  
  if (!user) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required',
      details: 'A valid JWT token is required to join a game'
    });
    return;
  }
  
  logLobbyOperation('Join game request', { joinCode, userId: user, selectedColor }, req);
  
  // Validate required fields
  if (!validateRequiredFields({ joinCode, user }, res)) {
    return;
  }
  
  // Validate UUID format for userId
  if (!validateUUID(user, 'userId', res)) {
    return;
  }
  
  // Validate join code format (8 alphanumeric characters)
  if (!/^[A-Z0-9]{8}$/i.test(joinCode)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid join code format',
      details: 'Join code must be 8 alphanumeric characters'
    });
    return;
  }
  
  const game = await LobbyService.joinGame(joinCode.toUpperCase(), { userId: user, selectedColor });
  
  logLobbyOperation('Player joined game successfully', { 
    gameId: game.id, 
    joinCode: joinCode,
    userId: user 
  }, req);
  
  res.status(200).json({
    success: true,
    data: game
  });
}));

// GET /api/lobby/games/:id - Get game information
router.get('/games/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  logLobbyOperation('Get game request', { gameId: id }, req);
  
  // Validate UUID format
  if (!validateUUID(id, 'gameId', res)) {
    return;
  }
  
  const game = await LobbyService.getGame(id);
  
  if (!game) {
    res.status(404).json({
      error: 'GAME_NOT_FOUND',
      message: 'Game not found',
      details: 'No game found with the provided ID'
    });
    return;
  }
  
  res.status(200).json({
    success: true,
    data: game
  });
}));

// GET /api/lobby/games/:id/players - Get all players in a game
router.get('/games/:id/players', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  logLobbyOperation('Get game players request', { gameId: id }, req);
  
  // Validate UUID format
  if (!validateUUID(id, 'gameId', res)) {
    return;
  }
  
  const players = await LobbyService.getGamePlayers(id);
  
  res.status(200).json({
    success: true,
    data: players
  });
}));

// GET /api/lobby/games/by-join-code/:joinCode - Get game by join code
router.get('/games/by-join-code/:joinCode', asyncHandler(async (req: Request, res: Response) => {
  const { joinCode } = req.params;
  
  logLobbyOperation('Get game by join code request', { joinCode }, req);
  
  // Validate join code format (8 alphanumeric characters)
  if (!/^[A-Z0-9]{8}$/i.test(joinCode)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid join code format',
      details: 'Join code must be 8 alphanumeric characters'
    });
    return;
  }
  
  const game = await LobbyService.getGameByJoinCode(joinCode.toUpperCase());
  
  if (!game) {
    res.status(404).json({
      error: 'GAME_NOT_FOUND',
      message: 'Game not found with that join code'
    });
    return;
  }
  
  res.status(200).json({
    success: true,
    data: game
  });
}));

// GET /api/lobby/games/:id/available-colors - Get available colors for a game
router.get('/games/:id/available-colors', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  logLobbyOperation('Get available colors request', { gameId: id }, req);
  
  // Validate UUID format
  if (!validateUUID(id, 'gameId', res)) {
    return;
  }
  
  const availableColors = await LobbyService.getAvailableColors(id);
  
  res.status(200).json({
    success: true,
    data: availableColors
  });
}));

// POST /api/lobby/games/:id/start - Start a game
router.post('/games/:id/start', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { creatorUserId }: StartGameRequest = req.body;
  const user = creatorUserId || req.headers['x-user-id'] as string;
  
  logLobbyOperation('Start game request', { gameId: id, creatorUserId: user }, req);
  
  // Validate required fields
  if (!validateRequiredFields({ user }, res)) {
    return;
  }
  
  // Validate UUID format
  if (!validateUUID(id, 'gameId', res) || !validateUUID(user, 'userId', res)) {
    return;
  }
  
  await LobbyService.startGame(id, user);
  
  res.status(200).json({
    success: true,
    message: 'Game started successfully'
  });
}));

// POST /api/lobby/games/:id/leave - Leave a game
router.post('/games/:id/leave', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { userId }: LeaveGameRequest = req.body;
  const user = userId || req.headers['x-user-id'] as string;
  
  logLobbyOperation('Leave game request', { gameId: id, userId: user }, req);
  
  // Validate required fields
  if (!validateRequiredFields({ user }, res)) {
    return;
  }
  
  // Validate UUID format
  if (!validateUUID(id, 'gameId', res) || !validateUUID(user, 'userId', res)) {
    return;
  }
  
  await LobbyService.leaveGame(id, user);
  
  res.status(200).json({
    success: true,
    message: 'Left game successfully'
  });
}));

// POST /api/lobby/players/presence - Update player online status
router.post('/players/presence', asyncHandler(async (req: Request, res: Response) => {
  const { userId, isOnline }: UpdatePresenceRequest = req.body;
  const user = userId || req.headers['x-user-id'] as string;
  
  logLobbyOperation('Update player presence request', { userId: user, isOnline }, req);
  
  // Validate required fields
  if (!validateRequiredFields({ user, isOnline }, res)) {
    return;
  }
  
  // Validate UUID format
  if (!validateUUID(user, 'userId', res)) {
    return;
  }
  
  // Validate isOnline is boolean
  if (typeof isOnline !== 'boolean') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'isOnline must be a boolean',
      details: 'Invalid isOnline value'
    });
    return;
  }
  
  await LobbyService.updatePlayerPresence(user, isOnline);
  
  res.status(200).json({
    success: true,
    message: 'Player presence updated successfully'
  });
}));

// POST /api/lobby/games/:id/bots - Add a bot to a game
router.post('/games/:id/bots', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id: gameId } = req.params;
  const userId = req.user!.id;
  const { skillLevel, archetype, name } = req.body;

  logLobbyOperation('Add bot request', { gameId, userId, skillLevel, archetype, name }, req);

  // Validate UUID format
  if (!validateUUID(gameId, 'gameId', res)) {
    return;
  }

  // Validate required fields
  if (!validateRequiredFields({ skillLevel, archetype }, res)) {
    return;
  }

  // Validate skillLevel enum
  if (!Object.values(BotSkillLevel).includes(skillLevel)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid skill level',
      details: `skillLevel must be one of: ${Object.values(BotSkillLevel).join(', ')}`
    });
    return;
  }

  // Resolve 'random' archetype to a concrete value
  let resolvedArchetype = archetype;
  if (archetype === 'random') {
    const archetypeValues = Object.values(BotArchetype);
    resolvedArchetype = archetypeValues[Math.floor(Math.random() * archetypeValues.length)];
  }

  // Validate archetype enum
  if (!Object.values(BotArchetype).includes(resolvedArchetype)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid archetype',
      details: `archetype must be one of: ${Object.values(BotArchetype).join(', ')}, random`
    });
    return;
  }

  // Validate name length if provided
  if (name !== undefined && (typeof name !== 'string' || name.length > 30)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid bot name',
      details: 'name must be a string of 30 characters or fewer'
    });
    return;
  }

  const botConfig: BotConfig = { skillLevel, archetype: resolvedArchetype, name };
  const bot = await LobbyService.addBot(gameId, userId, botConfig);

  logLobbyOperation('Bot added successfully', { gameId, botId: bot.id }, req);

  res.status(201).json({
    success: true,
    data: bot
  });
}));

// DELETE /api/lobby/games/:id/bots/:playerId - Remove a bot from a game
router.delete('/games/:id/bots/:playerId', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id: gameId, playerId } = req.params;
  const userId = req.user!.id;

  logLobbyOperation('Remove bot request', { gameId, userId, playerId }, req);

  // Validate UUID format
  if (!validateUUID(gameId, 'gameId', res) || !validateUUID(playerId, 'playerId', res)) {
    return;
  }

  await LobbyService.removeBot(gameId, userId, playerId);

  logLobbyOperation('Bot removed successfully', { gameId, playerId }, req);

  res.status(200).json({
    success: true,
    message: 'Bot removed successfully'
  });
}));

// GET /api/lobby/health - Health check endpoint
router.get('/health', asyncHandler(async (req: Request, res: Response) => {
  logLobbyOperation('Health check', { service: 'lobby-api' }, req);
  
  res.status(200).json({
    success: true,
    message: 'Lobby service is healthy',
    timestamp: new Date().toISOString(),
    service: 'lobby-api'
  });
}));

export default router;
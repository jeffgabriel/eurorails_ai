import express, { Request, Response, RequestHandler } from 'express';
import { LoadType } from '../../shared/types/LoadTypes';
import { loadService } from '../services/loadService';
import { authenticateToken } from '../middleware/authMiddleware';
import { PlayerService } from '../services/playerService';
import { emitStatePatch } from '../services/socketService';
import { db } from '../db';

const router = express.Router();

// Get initial load state including dropped loads
const getLoadState: RequestHandler = async (_req: Request, res: Response) => {
  try {
    const loadStates = await loadService.getAllLoadStates();
    res.json(loadStates);
  } catch (error) {
    console.error('Error getting load state:', error);
    res.status(500).json({ error: 'Failed to get load state' });
  }
};

// Get all dropped loads
// If gameId is provided, verify user is a player in that game
const getDroppedLoads: RequestHandler = async (req: Request, res: Response) => {
  const gameId = req.query.gameId as string;
  
  try {
    if (!gameId) {
      // Return empty array when no gameId provided (initial load)
      return res.json([]);
    }
    
    // If gameId is provided, verify user is authenticated and is a player
    if (req.user) {
      const isPlayer = await PlayerService.isUserPlayerInGame(gameId, req.user.id);
      if (!isPlayer) {
        return res.status(403).json({ 
          error: 'FORBIDDEN',
          details: 'You are not a player in this game' 
        });
      }
    }
    
    const droppedLoads = await loadService.getDroppedLoads(gameId);
    res.json(droppedLoads);
  } catch (error) {
    console.error('Error getting dropped loads:', error);
    res.status(500).json({ error: 'Failed to get dropped loads' });
  }
};

// Handle load pickup
const handleLoadPickup: RequestHandler = async (req: Request, res: Response) => {
  const { loadType, city, gameId } = req.body;
  
  try {
    if (!gameId) {
      return res.status(400).json({ error: 'Game ID is required' });
    }

    // Verify user is authenticated and is a player in the game
    if (!req.user) {
      return res.status(401).json({ 
        error: 'UNAUTHORIZED',
        details: 'Authentication required' 
      });
    }

    const isPlayer = await PlayerService.isUserPlayerInGame(gameId, req.user.id);
    if (!isPlayer) {
      return res.status(403).json({ 
        error: 'FORBIDDEN',
        details: 'You are not a player in this game' 
      });
    }

    const result = await loadService.pickupDroppedLoad(city, loadType, gameId);
    
    // Emit socket update with load state and dropped loads
    // Note: Player loads are updated separately via /api/players/update, which will emit its own socket update
    emitStatePatch(gameId, {
      // Load state changes are handled client-side from the response
      // Dropped loads are included in the response and will be synced via socket
    });
    
    res.json(result);
  } catch (error) {
    console.error('Error picking up load:', error);
    res.status(500).json({ error: 'Failed to pick up load' });
  }
};

// Handle load return to tray
const handleLoadReturn: RequestHandler = async (req: Request, res: Response) => {
  const { loadType, city, gameId } = req.body;
  
  try {
    if (!gameId) {
      return res.status(400).json({ error: 'Game ID is required' });
    }

    // Verify user is authenticated and is a player in the game
    if (!req.user) {
      return res.status(401).json({ 
        error: 'UNAUTHORIZED',
        details: 'Authentication required' 
      });
    }

    const isPlayer = await PlayerService.isUserPlayerInGame(gameId, req.user.id);
    if (!isPlayer) {
      return res.status(403).json({ 
        error: 'FORBIDDEN',
        details: 'You are not a player in this game' 
      });
    }
    
    if (city === undefined || city === null || city === '') {
      // If this game currently has a dropped load chip of this type, we must have a city to clear it.
      // Otherwise we'd risk incrementing availability while leaving the dropped chip visible.
      const droppedExists = await db.query(
        'SELECT 1 FROM load_chips WHERE game_id = $1 AND type = $2 AND is_dropped = true LIMIT 1',
        [gameId, loadType]
      );
      if (droppedExists.rows.length > 0) {
        return res.status(400).json({
          error: 'Validation error',
          details: 'city is required to return a dropped load'
        });
      }
      console.warn('[loadRoutes.return] Missing city in return request; proceeding because no dropped chip exists for this type', {
        gameId,
        loadType
      });
    }
    
    const result = await loadService.returnLoad(city, loadType, gameId);
    
    // Emit socket update with load state and dropped loads
    emitStatePatch(gameId, {
      // Load state changes are handled client-side from the response
      // Dropped loads are included in the response and will be synced via socket
    });
    
    res.json(result);
  } catch (error) {
    console.error('Error returning load:', error);
    res.status(500).json({ error: 'Failed to return load' });
  }
};

// Handle setting a load in a city (dropping)
const handleSetLoadInCity: RequestHandler = async (req: Request, res: Response) => {
  const { city, loadType, gameId } = req.body;
  
  try {
    if (!gameId) {
      return res.status(400).json({ error: 'Game ID is required' });
    }

    // Verify user is authenticated and is a player in the game
    if (!req.user) {
      return res.status(401).json({ 
        error: 'UNAUTHORIZED',
        details: 'Authentication required' 
      });
    }

    const isPlayer = await PlayerService.isUserPlayerInGame(gameId, req.user.id);
    if (!isPlayer) {
      return res.status(403).json({ 
        error: 'FORBIDDEN',
        details: 'You are not a player in this game' 
      });
    }

    const result = await loadService.setLoadInCity(city, loadType, gameId);
    
    // Emit socket update with dropped loads
    emitStatePatch(gameId, {
      // Dropped loads are included in the response and will be synced via socket
    });
    
    res.json(result);
  } catch (error) {
    console.error('Error setting load in city:', error);
    res.status(500).json({ error: 'Failed to set load in city' });
  }
};

// Register routes
router.get('/state', getLoadState);
router.get('/dropped', authenticateToken, getDroppedLoads); // GET with gameId query parameter - auth required if gameId provided
router.post('/pickup', authenticateToken, handleLoadPickup); // Auth required - verify user is player in game
router.post('/return', authenticateToken, handleLoadReturn); // Auth required - verify user is player in game
router.post('/setInCity', authenticateToken, handleSetLoadInCity); // Auth required - verify user is player in game

export default router; 
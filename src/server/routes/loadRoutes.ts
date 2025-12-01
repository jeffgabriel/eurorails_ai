import express, { Request, Response, RequestHandler } from 'express';
import { LoadType } from '../../shared/types/LoadTypes';
import { loadService } from '../services/loadService';
import { authenticateToken } from '../middleware/authMiddleware';
import { PlayerService } from '../services/playerService';

const router = express.Router();

// Get initial load state including dropped loads
const getLoadState: RequestHandler = async (_req: Request, res: Response) => {
  console.log('Received request for load state');
  try {
    const loadStates = await loadService.getAllLoadStates();
    console.log('Sending load states:', loadStates);
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
    
    const result = await loadService.returnLoad(city, loadType, gameId);
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
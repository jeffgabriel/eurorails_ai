import express, { Request, Response, RequestHandler } from 'express';
import { LoadType } from '../../shared/types/LoadTypes';
import { loadService } from '../services/loadService';
import { Session } from 'express-session';

declare module 'express-session' {
  interface SessionData {
    gameId: string;
  }
}

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
const getDroppedLoads: RequestHandler = async (req: Request, res: Response) => {
  const gameId = req.session.gameId;
  
  try {
    if (!gameId) {
      // Return empty array when no game session exists (initial load)
      return res.json([]);
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
  const { loadType, city } = req.body;
  const gameId = req.session.gameId;
  
  try {
    if (!gameId) {
      return res.status(400).json({ error: 'No game ID in session' });
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
  const { loadType, city } = req.body;
  const gameId = req.session.gameId;
  
  try {
    if (!gameId) {
      return res.status(400).json({ error: 'No game ID in session' });
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
  const { city, loadType } = req.body;
  const gameId = req.session.gameId;
  
  try {
    if (!gameId) {
      return res.status(400).json({ error: 'No game ID in session' });
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
router.get('/dropped', getDroppedLoads);
router.post('/pickup', handleLoadPickup);
router.post('/return', handleLoadReturn);
router.post('/setInCity', handleSetLoadInCity);

export default router; 
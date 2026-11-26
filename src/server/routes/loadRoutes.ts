import express, { Request, Response, RequestHandler } from 'express';
import { loadService } from '../services/loadService';
import { authenticateToken } from '../middleware/authMiddleware';
import { PlayerService } from '../services/playerService';

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

// Register routes
// Load pickup and drop are player actions: POST /api/players/pickup-load and /drop-load.
router.get('/state', getLoadState);
router.get('/dropped', authenticateToken, getDroppedLoads); // GET with gameId query parameter - auth required if gameId provided

export default router;

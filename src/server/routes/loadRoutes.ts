import express from 'express';
import { LoadService } from '../services/loadService';

const router = express.Router();
const loadService = LoadService.getInstance();

// GET /api/loads/state
router.get('/state', (req, res) => {
    console.log('Received request for load states');
    try {
        const loadStates = loadService.getAllLoadStates();
        console.log('Returning load states:', loadStates);
        res.json(loadStates);
    } catch (error) {
        console.error('Error fetching load states:', error);
        res.status(500).json({ error: 'Failed to fetch load states' });
    }
});

export default router; 
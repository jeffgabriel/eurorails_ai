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

// POST /api/loads/pickup
router.post('/pickup', (req, res) => {
    const { loadType } = req.body;
    console.log('Received request to pick up load:', loadType);
    
    try {
        const success = loadService.pickupLoad(loadType);
        if (success) {
            const updatedState = loadService.getLoadState(loadType);
            res.json(updatedState);
        } else {
            res.status(400).json({ error: 'Failed to pick up load' });
        }
    } catch (error) {
        console.error('Error picking up load:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/loads/return
router.post('/return', (req, res) => {
    const { loadType } = req.body;
    console.log('Received request to return load:', loadType);
    
    try {
        const success = loadService.returnLoad(loadType);
        if (success) {
            const updatedState = loadService.getLoadState(loadType);
            res.json(updatedState);
        } else {
            res.status(400).json({ error: 'Failed to return load' });
        }
    } catch (error) {
        console.error('Error returning load:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router; 
import express from 'express';
import { demandDeckService } from '../services/demandDeckService';

const router = express.Router();

// Get all demand cards
router.get('/demand', (req, res) => {
  try {
    const cards = demandDeckService.getAllCards();
    return res.status(200).json(cards);
  } catch (error: any) {
    console.error('Error fetching demand cards:', error);
    return res.status(500).json({ 
      error: 'Server error',
      details: error.message || 'An unexpected error occurred'
    });
  }
});

// Get a specific demand card by ID
router.get('/demand/:cardId', (req, res) => {
  try {
    const cardId = parseInt(req.params.cardId, 10);
    if (isNaN(cardId)) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'Card ID must be a number'
      });
    }

    const card = demandDeckService.getCard(cardId);
    if (!card) {
      return res.status(404).json({
        error: 'Not found',
        details: `Card with ID ${cardId} not found`
      });
    }

    return res.status(200).json(card);
  } catch (error: any) {
    console.error('Error fetching demand card:', error);
    return res.status(500).json({ 
      error: 'Server error',
      details: error.message || 'An unexpected error occurred'
    });
  }
});

// Test-only endpoint to reset the deck
// Allows reset in test environment or when called with test secret header
router.post('/reset', (req, res) => {
  try {
    const testSecret = req.headers['x-test-secret'] as string;
    const isTestEnvironment = process.env.NODE_ENV === 'test';
    const isValidTestRequest = isTestEnvironment || testSecret === 'test-reset-secret';
    
    // Only allow in test environment or with test secret
    if (!isValidTestRequest) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'This endpoint is only available in test mode'
      });
    }

    demandDeckService.reset();
    return res.status(200).json({
      message: 'Deck reset successfully',
      deckState: demandDeckService.getDeckState()
    });
  } catch (error: any) {
    console.error('Error resetting deck:', error);
    return res.status(500).json({ 
      error: 'Server error',
      details: error.message || 'An unexpected error occurred'
    });
  }
});

export default router;
import express from 'express';
import { DemandDeckService } from '../services/demandDeckService';
import { authenticateToken } from '../middleware/authMiddleware';

const router = express.Router();

// ---------------------------------------------------------------------------
// Definitional endpoints — "what is printed on a card".
// These are card-level data shared across all games, so they use the static
// definitional accessors and take no gameId.
// ---------------------------------------------------------------------------

// Get all demand cards
router.get('/demand', (req, res) => {
  try {
    const cards = DemandDeckService.getAllCards();
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

    const card = DemandDeckService.getCard(cardId);
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

// Get all event card definitions
router.get('/events', authenticateToken, (req, res) => {
  try {
    const cards = DemandDeckService.getAllEventCards();
    return res.status(200).json(cards);
  } catch (error: any) {
    console.error('Error fetching event cards:', error);
    return res.status(500).json({
      error: 'Server error',
      details: error.message || 'An unexpected error occurred'
    });
  }
});

// ---------------------------------------------------------------------------
// Deck-operational endpoints — act on a game's live deck state.
// Per-game debug operations require a gameId. The reset endpoint clears ALL
// per-game decks (test hygiene) and therefore takes no gameId.
// ---------------------------------------------------------------------------

/** Guards a request to test/debug-only endpoints. */
function isTestOrDebugRequest(req: express.Request): boolean {
  const testSecret = req.headers['x-test-secret'] as string;
  const isTestEnvironment = process.env.NODE_ENV === 'test';
  return isTestEnvironment || testSecret === 'test-reset-secret';
}

// Test-only endpoint: clear every game's in-memory deck so a fresh test run
// starts from a clean slate. Not per-game — resets all decks at once.
router.post('/reset', (req, res) => {
  try {
    if (!isTestOrDebugRequest(req)) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'This endpoint is only available in test mode'
      });
    }

    DemandDeckService.destroyAllInstances();
    return res.status(200).json({
      message: 'All game decks cleared'
    });
  } catch (error: any) {
    console.error('Error resetting decks:', error);
    return res.status(500).json({
      error: 'Server error',
      details: error.message || 'An unexpected error occurred'
    });
  }
});

// Debug endpoint: push an event card to the top of a specific game's draw pile
router.post('/debug/push-event', (req, res) => {
  try {
    if (!isTestOrDebugRequest(req)) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'This endpoint is only available in test/debug mode'
      });
    }

    const { gameId, eventCardId } = req.body;
    if (typeof gameId !== 'string' || gameId.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'gameId is required'
      });
    }
    if (typeof eventCardId !== 'number' || isNaN(eventCardId)) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'eventCardId must be a number (121-140)'
      });
    }

    const deck = DemandDeckService.getInstanceForGame(gameId);
    deck.pushEventCardToTop(eventCardId);
    return res.status(200).json({
      message: `Event card ${eventCardId} pushed to top of draw pile for game ${gameId}`,
      deckState: deck.getDeckState()
    });
  } catch (error: any) {
    return res.status(400).json({
      error: 'Bad request',
      details: error.message || 'Failed to push event card'
    });
  }
});

// Debug endpoint: reshuffle a specific game's draw+discard piles, preserving dealt cards
router.post('/debug/reshuffle', (req, res) => {
  try {
    if (!isTestOrDebugRequest(req)) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'This endpoint is only available in test/debug mode'
      });
    }

    const { gameId } = req.body;
    if (typeof gameId !== 'string' || gameId.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'gameId is required'
      });
    }

    const result = DemandDeckService.getInstanceForGame(gameId).reshuffle();
    return res.status(200).json({
      message: `Deck reshuffled for game ${gameId} (dealt cards preserved)`,
      ...result,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: 'Server error',
      details: error.message || 'Failed to reshuffle deck'
    });
  }
});

export default router;

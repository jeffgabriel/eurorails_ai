/**
 * API smoke tests for GET /api/deck/events endpoint.
 *
 * Verifies:
 * - 401 Unauthorized when no JWT is provided
 * - 401 Unauthorized when JWT is invalid
 * - 200 OK with event card array when JWT is valid
 * - Response contains event cards with correct structure
 */

import request from 'supertest';
import express from 'express';
import deckRoutes from '../routes/deckRoutes';
import { AuthService } from '../services/authService';
import { EventCardType } from '../../shared/types/EventCard';

jest.mock('../services/authService');
jest.mock('../services/demandDeckService', () => ({
  demandDeckService: {
    getAllCards: jest.fn(() => []),
    getAllEventCards: jest.fn(() => [
      {
        id: 121,
        type: EventCardType.Strike,
        title: 'Coastal Strike!',
        description: 'No train may pick up or deliver any load at any city within 3 mileposts of any coast.',
        effectConfig: { type: EventCardType.Strike, variant: 'coastal', coastalRadius: 3 },
      },
      {
        id: 130,
        type: EventCardType.Snow,
        title: 'Snow!',
        description: 'All trains within 6 mileposts of Torino move at half rate.',
        effectConfig: { type: EventCardType.Snow, centerCity: 'Torino', radius: 6, blockedTerrain: [3] },
      },
    ]),
    getCard: jest.fn(),
    reset: jest.fn(),
    getDeckState: jest.fn(() => ({ totalCards: 166, drawPileSize: 166, discardPileSize: 0, dealtCardsCount: 0 })),
  },
}));

const mockAuthService = AuthService as jest.Mocked<typeof AuthService>;

const mockUser = {
  id: 'test-user-id',
  username: 'testuser',
  email: 'test@example.com',
  emailVerified: true,
  createdAt: new Date(),
  lastActive: new Date(),
  updatedAt: new Date(),
};

const mockTokenPayload = {
  userId: 'test-user-id',
  username: 'testuser',
  email: 'test@example.com',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
};

const app = express();
app.use(express.json());
app.use('/api/deck', deckRoutes);

describe('GET /api/deck/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const response = await request(app).get('/api/deck/events');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHORIZED');
    });

    it('should return 401 when token is invalid', async () => {
      mockAuthService.verifyToken.mockReturnValue(null);
      const response = await request(app)
        .get('/api/deck/events')
        .set('Authorization', 'Bearer invalid.token.here');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHORIZED');
    });

    it('should return 401 when user no longer exists', async () => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(null);
      const response = await request(app)
        .get('/api/deck/events')
        .set('Authorization', 'Bearer valid.token.here');
      expect(response.status).toBe(401);
    });
  });

  describe('Happy path', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 200 with event cards array', async () => {
      const response = await request(app)
        .get('/api/deck/events')
        .set('Authorization', 'Bearer valid.token.here');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should return event cards with required fields (id, type, title, description, effectConfig)', async () => {
      const response = await request(app)
        .get('/api/deck/events')
        .set('Authorization', 'Bearer valid.token.here');

      expect(response.status).toBe(200);
      const cards = response.body;
      expect(cards.length).toBeGreaterThan(0);

      const card = cards[0];
      expect(card).toHaveProperty('id');
      expect(card).toHaveProperty('type');
      expect(card).toHaveProperty('title');
      expect(card).toHaveProperty('description');
      expect(card).toHaveProperty('effectConfig');
    });

    it('should return cards with valid EventCardType values', async () => {
      const response = await request(app)
        .get('/api/deck/events')
        .set('Authorization', 'Bearer valid.token.here');

      expect(response.status).toBe(200);
      const validTypes = Object.values(EventCardType);
      for (const card of response.body as any[]) {
        expect(validTypes).toContain(card.type);
      }
    });

    it('should include Strike and Snow card types in the response', async () => {
      const response = await request(app)
        .get('/api/deck/events')
        .set('Authorization', 'Bearer valid.token.here');

      expect(response.status).toBe(200);
      const types = (response.body as any[]).map((c) => c.type);
      expect(types).toContain(EventCardType.Strike);
      expect(types).toContain(EventCardType.Snow);
    });
  });
});

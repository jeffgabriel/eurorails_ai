import jwt from 'jsonwebtoken';
import { AuthService } from '../services/authService';

jest.mock('../db', () => ({ db: { query: jest.fn() } }));

describe('AuthService JWT secret', () => {
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  it('should throw from assertConfigured when JWT_SECRET is not set', () => {
    delete process.env.JWT_SECRET;

    expect(() => AuthService.assertConfigured()).toThrow('JWT_SECRET environment variable is not set');
  });

  it('should not throw from assertConfigured when JWT_SECRET is set', () => {
    process.env.JWT_SECRET = 'configured-secret';

    expect(() => AuthService.assertConfigured()).not.toThrow();
  });

  it('should reject a token signed with the old hard-coded default secret', () => {
    process.env.JWT_SECRET = 'configured-secret';
    const forged = jwt.sign({ userId: 'attacker' }, 'your-secret-key-change-in-production');

    expect(AuthService.verifyToken(forged)).toBeNull();
  });

  it('should verify a token signed with the configured secret', () => {
    process.env.JWT_SECRET = 'configured-secret';
    const token = jwt.sign({ userId: 'user-1' }, 'configured-secret');

    expect(AuthService.verifyToken(token)).toMatchObject({ userId: 'user-1' });
  });
});

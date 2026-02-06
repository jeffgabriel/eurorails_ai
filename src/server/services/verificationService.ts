import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { emailService } from './emailService';

export interface VerificationResult {
  success: boolean;
  userId?: string;
  error?: string;
}

/**
 * Service for managing email verification tokens and sending verification emails
 */
export class VerificationService {
  private static readonly TOKEN_EXPIRY_MINUTES = 15;

  /**
   * Generate a secure random verification token
   */
  private static generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate and store a verification token for a user
   */
  static async generateVerificationToken(userId: string): Promise<string> {
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + this.TOKEN_EXPIRY_MINUTES * 60 * 1000);

    try {
      // Delete any existing tokens for this user
      await db.query(
        'DELETE FROM email_verification_tokens WHERE user_id = $1',
        [userId]
      );

      // Insert new token
      await db.query(
        `INSERT INTO email_verification_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, token, expiresAt]
      );

      console.log(`[Verification] Generated token for user ${userId}, expires at ${expiresAt.toISOString()}`);
      return token;
    } catch (error) {
      console.error('[Verification] Error generating token:', error);
      throw new Error('Failed to generate verification token');
    }
  }

  /**
   * Send verification email to user
   */
  static async sendVerificationEmail(
    userId: string,
    email: string,
    username: string
  ): Promise<void> {
    try {
      // Generate new token
      const token = await this.generateVerificationToken(userId);

      // Construct verification URL using API base URL (not client URL)
      // This ensures the link points directly to the backend API endpoint
      const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const verificationUrl = `${apiBaseUrl}/api/auth/verify-email?token=${token}`;

      // Send email
      await emailService.sendVerificationEmail(email, username, verificationUrl);

      console.log(`[Verification] Sent verification email to ${email}`);
    } catch (error) {
      console.error('[Verification] Error sending verification email:', error);
      throw new Error('Failed to send verification email');
    }
  }

  /**
   * Verify a token and mark user's email as verified
   * Uses transaction to ensure atomicity
   */
  static async verifyToken(token: string): Promise<VerificationResult> {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // Find token
      const tokenResult = await client.query(
        `SELECT user_id, expires_at 
         FROM email_verification_tokens 
         WHERE token = $1`,
        [token]
      );

      if (tokenResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'INVALID_TOKEN',
        };
      }

      const { user_id: userId, expires_at: expiresAt } = tokenResult.rows[0];

      // Check if token has expired
      if (new Date() > new Date(expiresAt)) {
        // Clean up expired token
        await client.query(
          'DELETE FROM email_verification_tokens WHERE token = $1',
          [token]
        );
        await client.query('COMMIT');
        
        return {
          success: false,
          error: 'TOKEN_EXPIRED',
        };
      }

      // Mark user as verified
      await client.query(
        'UPDATE users SET email_verified = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [userId]
      );

      // Delete used token
      await client.query(
        'DELETE FROM email_verification_tokens WHERE token = $1',
        [token]
      );

      await client.query('COMMIT');

      console.log(`[Verification] User ${userId} email verified successfully`);

      return {
        success: true,
        userId,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Verification] Error verifying token:', error);
      return {
        success: false,
        error: 'VERIFICATION_ERROR',
      };
    } finally {
      client.release();
    }
  }

  /**
   * Clean up expired tokens (called by cron job)
   */
  static async cleanupExpiredTokens(): Promise<number> {
    try {
      const result = await db.query(
        'DELETE FROM email_verification_tokens WHERE expires_at < CURRENT_TIMESTAMP RETURNING id'
      );

      const deletedCount = result.rows.length;
      if (deletedCount > 0) {
        console.log(`[Verification] Cleaned up ${deletedCount} expired tokens`);
      }

      return deletedCount;
    } catch (error) {
      console.error('[Verification] Error cleaning up expired tokens:', error);
      return 0;
    }
  }

  /**
   * Check if user's email is verified
   */
  static async isEmailVerified(userId: string): Promise<boolean> {
    try {
      const result = await db.query(
        'SELECT email_verified FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return false;
      }

      return result.rows[0].email_verified === true;
    } catch (error) {
      console.error('[Verification] Error checking email verification:', error);
      return false;
    }
  }
}

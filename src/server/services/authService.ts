import { db } from '../db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRow, LoginForm, RegisterForm, AuthResult, JWTPayload } from '../../shared/types/AuthTypes';

export class AuthService {
  private static readonly SALT_ROUNDS = 12;
  private static readonly JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  private static readonly JWT_EXPIRES_IN = '60m';
  private static readonly REFRESH_TOKEN_EXPIRES_IN = '7d';

  /**
   * Hash a password using bcrypt
   */
  private static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.SALT_ROUNDS);
  }

  /**
   * Verify a password against its hash
   */
  private static async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Generate JWT access token
   */
  private static generateAccessToken(user: User): string {
    const payload: JWTPayload = {
      userId: user.id,
      email: user.email,
      username: user.username,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (60 * 60), // 60 minutes
    };
    return jwt.sign(payload, this.JWT_SECRET);
  }

  /**
   * Generate refresh token
   */
  private static generateRefreshToken(userId: string): string {
    return jwt.sign(
      { 
        type: 'refresh',
        userId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) // 7 days
      },
      this.JWT_SECRET
    );
  }

  /**
   * Verify and decode JWT token
   */
  static verifyToken(token: string): JWTPayload | null {
    try {
      return jwt.verify(token, this.JWT_SECRET) as JWTPayload;
    } catch (error) {
      return null;
    }
  }

  /**
   * Convert database row to User object
   */
  private static rowToUser(row: UserRow): User {
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      emailVerified: row.email_verified,
      createdAt: row.created_at,
      lastActive: row.last_active,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Validate email format
   */
  private static validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validate password strength
   */
  private static validatePassword(password: string): { valid: boolean; message?: string } {
    if (password.length < 8) {
      return { valid: false, message: 'Password must be at least 8 characters long' };
    }
    if (!/(?=.*[a-z])/.test(password)) {
      return { valid: false, message: 'Password must contain at least one lowercase letter' };
    }
    if (!/(?=.*[A-Z])/.test(password)) {
      return { valid: false, message: 'Password must contain at least one uppercase letter' };
    }
    if (!/(?=.*\d)/.test(password)) {
      return { valid: false, message: 'Password must contain at least one number' };
    }
    return { valid: true };
  }

  /**
   * Validate username format
   */
  private static validateUsername(username: string): { valid: boolean; message?: string } {
    if (username.length < 3) {
      return { valid: false, message: 'Username must be at least 3 characters long' };
    }
    if (username.length > 50) {
      return { valid: false, message: 'Username must be no more than 50 characters long' };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return { valid: false, message: 'Username can only contain letters, numbers, underscores, and hyphens' };
    }
    return { valid: true };
  }

  /**
   * Register a new user
   */
  static async register(userData: RegisterForm): Promise<AuthResult> {
    // Validate input
    if (!this.validateEmail(userData.email)) {
      throw new Error('Invalid email format');
    }

    const usernameValidation = this.validateUsername(userData.username);
    if (!usernameValidation.valid) {
      throw new Error(usernameValidation.message);
    }

    const passwordValidation = this.validatePassword(userData.password);
    if (!passwordValidation.valid) {
      throw new Error(passwordValidation.message);
    }

    if (userData.password !== userData.confirmPassword) {
      throw new Error('Passwords do not match');
    }

    // Check if user already exists
    const existingUser = await this.findUserByEmail(userData.email);
    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    const existingUsername = await this.findUserByUsername(userData.username);
    if (existingUsername) {
      throw new Error('Username is already taken');
    }

    // Hash password
    const passwordHash = await this.hashPassword(userData.password);

    // Create user
    const userId = uuidv4();
    const query = `
      INSERT INTO users (id, username, email, password_hash, email_verified)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    
    const result = await db.query(query, [
      userId,
      userData.username,
      userData.email.toLowerCase(),
      passwordHash,
      false // Email not verified initially
    ]);

    const user = this.rowToUser(result.rows[0]);
    const token = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user.id);

    return {
      user,
      token,
      refreshToken
    };
  }

  /**
   * Login user
   */
  static async login(credentials: LoginForm): Promise<AuthResult> {
    // Validate email format
    if (!this.validateEmail(credentials.email)) {
      throw new Error('Invalid email format');
    }

    // Find user by email
    const user = await this.findUserByEmail(credentials.email);
    if (!user) {
      throw new Error('Invalid email or password');
    }

    // Verify password
    const isValidPassword = await this.verifyPassword(credentials.password, user.password_hash);
    if (!isValidPassword) {
      throw new Error('Invalid email or password');
    }

    // Update last active timestamp
    await this.updateLastActive(user.id);

    // Convert to User object and generate tokens
    const userObj = this.rowToUser(user);
    const token = this.generateAccessToken(userObj);
    const refreshToken = this.generateRefreshToken(userObj.id);

    return {
      user: userObj,
      token,
      refreshToken
    };
  }

  /**
   * Find user by email
   */
  static async findUserByEmail(email: string): Promise<UserRow | null> {
    const query = 'SELECT * FROM users WHERE email = $1';
    const result = await db.query(query, [email.toLowerCase()]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Find user by username
   */
  static async findUserByUsername(username: string): Promise<UserRow | null> {
    const query = 'SELECT * FROM users WHERE username = $1';
    const result = await db.query(query, [username]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Find user by ID
   */
  static async findUserById(userId: string): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await db.query(query, [userId]);
    return result.rows.length > 0 ? this.rowToUser(result.rows[0]) : null;
  }

  /**
   * Update user's last active timestamp
   */
  static async updateLastActive(userId: string): Promise<void> {
    const query = 'UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = $1';
    await db.query(query, [userId]);
  }

  /**
   * Verify refresh token and generate new access token
   */
  static async refreshAccessToken(refreshToken: string): Promise<{ token: string; refreshToken: string }> {
    try {
      const decoded = jwt.verify(refreshToken, this.JWT_SECRET) as any;
      if (decoded.type !== 'refresh') {
        throw new Error('Invalid refresh token');
      }

      // Generate new tokens
      const user = await this.findUserById(decoded.userId);
      if (!user) {
        throw new Error(`User not found: ${decoded.userId}`);
      }
      const newToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user.id);

      return {
        token: newToken,
        refreshToken: newRefreshToken
      };
    } catch (error) {
      throw new Error('Invalid refresh token');
    }
  }

  /**
   * Change user password
   */
  static async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    // Get current user
    const user = await this.findUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Get user with password hash
    const userWithHash = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (userWithHash.rows.length === 0) {
      throw new Error('User not found');
    }

    // Verify current password
    const isValidPassword = await this.verifyPassword(currentPassword, userWithHash.rows[0].password_hash);
    if (!isValidPassword) {
      throw new Error('Current password is incorrect');
    }

    // Validate new password
    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new Error(passwordValidation.message);
    }

    // Hash new password and update
    const newPasswordHash = await this.hashPassword(newPassword);
    const query = 'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
    await db.query(query, [newPasswordHash, userId]);
  }

  /**
   * Delete user account
   */
  static async deleteUser(userId: string): Promise<void> {
    const query = 'DELETE FROM users WHERE id = $1';
    await db.query(query, [userId]);
  }
}

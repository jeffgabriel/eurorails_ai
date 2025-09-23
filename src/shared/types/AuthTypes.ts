// Authentication types for the EuroRails AI application

export interface User {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  lastActive: Date;
  updatedAt: Date;
}

export interface LoginForm {
  email: string;
  password: string;
}

export interface RegisterForm {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface AuthResult {
  user: User;
  token: string;
  refreshToken?: string;
}

export interface RefreshTokenResult {
  token: string;
  refreshToken: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: string;
}

// JWT payload interface
export interface JWTPayload {
  userId: string;
  email: string;
  username: string;
  iat: number;
  exp: number;
}

// Database row interface for users table
export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  email_verified: boolean;
  created_at: Date;
  last_active: Date;
  updated_at: Date;
}

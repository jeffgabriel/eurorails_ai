# User Authentication Foundation - Implementation Plan

## 🎯 **Overview**
This document outlines the implementation plan for Issue #64: User Authentication Foundation. The goal is to implement email/password authentication while maintaining backward compatibility and preparing for future third-party OAuth integration.

## 🏗️ **Current Architecture**
- **Backend**: Node.js + Express.js + PostgreSQL
- **Frontend**: React 18 + TypeScript + Vite + Zustand
- **Database**: PostgreSQL with migration system
- **Authentication**: Currently using simple UUIDs (no real auth)
- **Real-time**: Socket.IO for multiplayer features

## 📋 **Implementation Phases**

### **Phase 1: Database Foundation** (1-2 hours)
**Goal**: Create users table and update existing schema

#### **Tasks**
1. Create migration `012_add_users_table.sql`
2. Add users table with authentication fields
3. Update players table foreign key constraints
4. Update games table to reference users
5. Test migration in clean environment

#### **Checkpoints**
- [ ] Users table created with proper indexes
- [ ] Foreign key constraints updated
- [ ] Migration tested successfully
- [ ] Database schema documented

---

### **Phase 2: Backend Authentication Service** (2-3 hours)
**Goal**: Implement authentication logic and JWT handling

#### **Tasks**
1. Install required dependencies (bcryptjs, jsonwebtoken)
2. Create AuthService class
3. Implement password hashing and verification
4. Implement JWT token generation and validation
5. Create authentication middleware
6. Add user management methods

#### **Checkpoints**
- [ ] Dependencies installed
- [ ] AuthService implemented
- [ ] Password security working
- [ ] JWT tokens generated and validated
- [ ] Middleware created and tested

---

### **Phase 3: API Endpoints** (1-2 hours)
**Goal**: Create authentication REST endpoints

#### **Tasks**
1. Create auth routes (`/api/auth/*`)
2. Implement register, login, logout endpoints
3. Add user profile and refresh token endpoints
4. Update existing routes with authentication
5. Add input validation and error handling

#### **Checkpoints**
- [ ] All auth endpoints implemented
- [ ] Input validation working
- [ ] Error handling comprehensive
- [ ] Existing routes updated
- [ ] API documentation updated

---

### **Phase 4: Frontend Integration** (2-3 hours)
**Goal**: Update frontend to use real authentication

#### **Tasks**
1. Update auth store with real API calls
2. Create auth components (LoginForm, RegisterForm)
3. Update API client for authentication
4. Implement token persistence and refresh
5. Update protected routes

#### **Checkpoints**
- [ ] Auth store updated
- [ ] Auth components created
- [ ] API client updated
- [ ] Token management working
- [ ] Protected routes implemented

---

### **Phase 5: Testing & Validation** (1-2 hours)
**Goal**: Ensure authentication works correctly

#### **Tasks**
1. Write backend unit tests
2. Write integration tests
3. Update frontend tests
4. Test end-to-end flows
5. Performance and security testing

#### **Checkpoints**
- [ ] Backend tests passing
- [ ] Frontend tests updated
- [ ] E2E tests working
- [ ] Security tests passing
- [ ] Performance acceptable

---

## **Technical Specifications**

### **Database Schema**
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_active TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### **JWT Token Strategy**
- **Access Token**: 15-30 minutes
- **Refresh Token**: 7-30 days
- **Storage**: HTTP-only cookies for refresh, localStorage for access
- **Rotation**: Implement refresh token rotation

### **Security Requirements**
- Password hashing with bcryptjs (12+ salt rounds)
- Rate limiting on auth endpoints
- Input validation and sanitization
- CORS configuration for auth endpoints
- Secure cookie settings

---

## 🎯 **Success Criteria**

- [ ] Users can register with email/password
- [ ] Users can login and receive JWT tokens
- [ ] All existing lobby functionality works with authentication
- [ ] Password security meets industry standards
- [ ] Token management handles expiration gracefully
- [ ] All tests pass (maintain 287+ test count)
- [ ] Backward compatibility maintained for development
- [ ] Ready for third-party auth integration

---

## 🚨 **Risk Mitigation**

1. **Backward Compatibility**: Keep existing UUID system as fallback
2. **Database Migration**: Test migrations thoroughly in staging
3. **Token Security**: Implement proper token validation and rotation
4. **User Experience**: Ensure smooth transition from mock to real auth
5. **Testing**: Comprehensive test coverage for all auth flows

---

## 📊 **Timeline & Effort**

| Phase | Effort | Dependencies | Status |
|-------|--------|--------------|--------|
| Phase 1: Database | 1-2 hours | None | ⏳ Pending |
| Phase 2: Backend Service | 2-3 hours | Phase 1 | ⏳ Pending |
| Phase 3: API Endpoints | 1-2 hours | Phase 2 | ⏳ Pending |
| Phase 4: Frontend Integration | 2-3 hours | Phase 3 | ⏳ Pending |
| Phase 5: Testing | 1-2 hours | Phase 4 | ⏳ Pending |
| **Total** | **7-12 hours** | Sequential | **⏳ Pending** |

---

## 🔄 **Future Extensibility**

### **Third-Party Authentication**
- Google OAuth: Add `google_id` column
- GitHub OAuth: Add `github_id` column
- Discord OAuth: Add `discord_id` column

### **Advanced Features**
- Email verification system
- Two-factor authentication (2FA)
- Account recovery and password reset
- User profile management
- Activity tracking and analytics

---

**Last Updated**: [Current Date]
**Status**: Ready to begin Phase 1
**Next Step**: Create users table migration

-- Migration 012: Add users table for authentication
-- This migration creates the users table and updates existing schema

-- Create users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_active TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add indexes for performance
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_last_active ON users(last_active);

-- Add updated_at trigger
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Update players table to reference users
ALTER TABLE players 
ADD CONSTRAINT fk_players_user_id 
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Update games table to reference users instead of players
ALTER TABLE games 
DROP CONSTRAINT IF EXISTS fk_games_created_by;
ALTER TABLE games 
ADD CONSTRAINT fk_games_created_by 
FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;

-- Add comments explaining the new columns
COMMENT ON TABLE users IS 'User accounts for authentication and game participation';
COMMENT ON COLUMN users.username IS 'Unique username for display and login';
COMMENT ON COLUMN users.email IS 'Unique email address for login and notifications';
COMMENT ON COLUMN users.password_hash IS 'Hashed password using bcrypt';
COMMENT ON COLUMN users.email_verified IS 'Whether the email address has been verified';
COMMENT ON COLUMN users.last_active IS 'Last time the user was active in the system';
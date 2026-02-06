# Email Verification URL Configuration

## Problem
Email verification links must point to the backend API server, not the frontend client, to avoid 404 errors in split deployment scenarios.

## Solution
We use two separate environment variables:

### `API_BASE_URL`
- **Purpose**: Base URL of the backend API server
- **Used for**: Building email verification links
- **Development**: `http://localhost:3001`
- **Production**: Your API server URL (e.g., `https://api.eurorails.com`)

### `CLIENT_URL`
- **Purpose**: Base URL of the frontend client
- **Used for**: CORS configuration and post-verification redirects
- **Development**: `http://localhost:3000`
- **Production**: Your frontend URL (e.g., `https://eurorails.com`)

## Email Verification Flow

1. **User registers** → Backend sends verification email
2. **Email contains link** → `${API_BASE_URL}/api/auth/verify-email?token=xxx`
3. **User clicks link** → Hits backend API server directly
4. **Backend verifies token** → Marks email as verified in database
5. **Backend redirects** → `${CLIENT_URL}/login?verified=true`
6. **User sees success** → Frontend shows verification success message

## Configuration

### Development (.env)
```bash
API_BASE_URL=http://localhost:3001
CLIENT_URL=http://localhost:3000
```

### Production (Railway/Cloud)
```bash
API_BASE_URL=https://api.eurorails.com
CLIENT_URL=https://eurorails.com
```

### Docker Compose
```yaml
environment:
  - API_BASE_URL=http://backend:3001
  - CLIENT_URL=http://localhost:3000
```

## Why This Matters

### ❌ Wrong Approach (Before Fix)
```typescript
const baseUrl = process.env.CLIENT_URL; // http://localhost:3000
const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;
// Link: http://localhost:3000/api/auth/verify-email?token=xxx
// Problem: Frontend server has no /api/auth/verify-email route → 404
```

### ✅ Correct Approach (After Fix)
```typescript
const apiBaseUrl = process.env.API_BASE_URL; // http://localhost:3001
const verificationUrl = `${apiBaseUrl}/api/auth/verify-email?token=${token}`;
// Link: http://localhost:3001/api/auth/verify-email?token=xxx
// Success: Hits backend API server directly → Verification works
```

## Deployment Checklist

When deploying to production:

- [ ] Set `API_BASE_URL` to your backend API domain
- [ ] Set `CLIENT_URL` to your frontend domain
- [ ] Verify email verification flow in production
- [ ] Check that post-verification redirect works
- [ ] Test with split deployment (frontend and backend on different origins)

## Alternative Approach (Not Implemented)

Another valid approach would be to:
1. Have verification links point to a frontend route (e.g., `/verify-email?token=xxx`)
2. Frontend route calls backend API to verify token
3. Frontend shows success/error message

We chose the direct API approach because:
- Simpler implementation
- No frontend route needed
- Works even if frontend is temporarily down
- Standard pattern for email verification

## Related Files
- `src/server/services/verificationService.ts` - Builds verification URLs
- `src/server/routes/authRoutes.ts` - Handles verification and redirects
- `.env` - Configuration

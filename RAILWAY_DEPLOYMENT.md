# Railway Deployment Guide

This guide covers deploying the Eurorails AI application to Railway.

## Why Railway?

Railway is an excellent choice for this deployment because it provides:
- **Managed PostgreSQL** - No need to manage database infrastructure
- **Automatic HTTPS/SSL** - Free SSL certificates for all deployments
- **WebSocket Support** - Native support for Socket.IO connections
- **Environment Variables** - Easy configuration management
- **Git Integration** - Automatic deployments from Git
- **Docker Support** - Full control over build process
- **Health Checks** - Built-in monitoring and auto-restart

## Prerequisites

1. A Railway account (sign up at [railway.app](https://railway.app))
2. Your code pushed to a Git repository (GitHub, GitLab, or Bitbucket)
3. Railway CLI installed (optional, for local testing)

## Deployment Steps

### 1. Create Railway Project

1. Log in to Railway dashboard
2. Click "New Project"
3. Select "Deploy from GitHub repo" (or your Git provider)
4. Select your repository

### 2. Add PostgreSQL Service

1. In your Railway project, click "+ New"
2. Select "Database" → "Add PostgreSQL"
3. Railway will automatically create a PostgreSQL instance
4. Note the `DATABASE_URL` environment variable (Railway provides this automatically)

### 3. Add Application Service

1. In your Railway project, click "+ New"
2. Select "GitHub Repo" (or your Git provider)
3. Select your repository
4. Railway will detect the Dockerfile.prod and start building

### 4. Configure Environment Variables

In your application service, add the following environment variables:

#### Required Variables

```env
# Railway provides these automatically - DO NOT override
PORT=3000  # Railway sets this automatically
DATABASE_URL=postgresql://...  # Railway provides this from PostgreSQL service

# Application Configuration
NODE_ENV=production

# CORS Configuration (REQUIRED for production)
# Replace with your Railway domain after first deployment
CLIENT_URL=https://your-app-name.up.railway.app

# Session Security (REQUIRED - generate a strong secret)
SESSION_SECRET=your-very-strong-random-secret-key-here

# Client Build Configuration
# Set these BEFORE building, or rebuild after setting
VITE_API_BASE_URL=https://your-app-name.up.railway.app
VITE_SOCKET_URL=https://your-app-name.up.railway.app
```

#### Optional Variables

```env
# If you have multiple domains
ALLOWED_ORIGINS=https://your-app-name.up.railway.app,https://www.yourdomain.com

# Database Configuration (if not using DATABASE_URL)
# These are only needed if DATABASE_URL is not set
DB_SSL=true
DB_MAX_CONNECTIONS=20
```

### 5. Link PostgreSQL to Application

1. In your application service settings
2. Go to "Variables" tab
3. Click "Reference Variable"
4. Select your PostgreSQL service
5. Select `DATABASE_URL`
6. Railway will automatically inject this into your application

### 6. Generate Session Secret

Generate a strong session secret:

```bash
# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Using OpenSSL
openssl rand -hex 32
```

Add this as `SESSION_SECRET` environment variable.

### 7. First Deployment

1. Railway will automatically build and deploy when you push to your main branch
2. Wait for the build to complete
3. Check the deployment logs for any errors
4. Once deployed, Railway will provide a public URL like `https://your-app-name.up.railway.app`

### 8. Update CORS Configuration

After your first deployment:

1. Note your Railway-provided domain (e.g., `https://your-app-name.up.railway.app`)
2. Update `CLIENT_URL` environment variable with your domain
3. Update `VITE_API_BASE_URL` and `VITE_SOCKET_URL` with your domain
4. **Important:** Since client variables are build-time, you'll need to trigger a rebuild:
   - Either push a new commit, or
   - Use Railway's "Redeploy" button after updating variables

### 9. Custom Domain (Optional)

1. In your Railway service, go to "Settings"
2. Click "Generate Domain" or "Add Custom Domain"
3. Follow Railway's instructions for DNS configuration
4. Update your `CLIENT_URL` and client build variables with the new domain

## Environment Variables Reference

### Railway-Provided Variables

These are automatically set by Railway - **do not override**:

- `PORT` - Port your application should listen on (Railway sets this)
- `DATABASE_URL` - PostgreSQL connection string (from PostgreSQL service)
- `RAILWAY_ENVIRONMENT` - Environment name (production, staging, etc.)
- `RAILWAY_PUBLIC_DOMAIN` - Your Railway public domain

### Application Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NODE_ENV` | Yes | Environment mode | `production` |
| `CLIENT_URL` | Yes | Primary client URL for CORS | `https://your-app.up.railway.app` |
| `SESSION_SECRET` | Yes | Secret for session encryption | `generated-secret-key` |
| `VITE_API_BASE_URL` | Yes* | API base URL (build-time) | `https://your-app.up.railway.app` |
| `VITE_SOCKET_URL` | Yes* | Socket.IO URL (build-time) | `https://your-app.up.railway.app` |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins | `https://app.com,https://www.app.com` |
| `DB_SSL` | No | Enable SSL for database | `true` (default for Railway) |
| `DB_MAX_CONNECTIONS` | No | Max DB connections | `20` |

*Required before building - set these before first deployment or rebuild after setting

## Database Migrations

Database migrations run automatically on application startup via `checkDatabase()` in `src/server/db/index.ts`. The application will:

1. Connect to the database (with retry logic)
2. Check current schema version
3. Apply any pending migrations
4. Start the server

**Note:** Migrations run in a transaction - if any migration fails, all changes are rolled back.

## Health Checks

Railway monitors the `/health` endpoint to determine if your application is running. The endpoint returns:

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 123.456
}
```

If the health check fails, Railway will automatically restart your service.

## Build Process

The production Dockerfile (`Dockerfile.prod`) uses a multi-stage build:

1. **Build Stage**: Installs all dependencies and builds the application
2. **Production Stage**: Copies only production dependencies and built files

This results in a smaller, more secure production image.

## Troubleshooting

### Build Fails

- Check build logs in Railway dashboard
- Verify all required files are in the repository
- Ensure `package.json` has correct build scripts

### Database Connection Fails

- Verify `DATABASE_URL` is set correctly
- Check that PostgreSQL service is running
- Ensure database migrations can access migration files
- Check database connection logs in application logs

### CORS Errors

- Verify `CLIENT_URL` matches your actual domain
- Check browser console for specific CORS errors
- Ensure `ALLOWED_ORIGINS` includes all necessary domains
- Remember: client build variables require a rebuild after changing

### Socket.IO Not Connecting

- Verify `VITE_SOCKET_URL` is set correctly (requires rebuild)
- Check that WebSocket connections are enabled in Railway
- Verify Socket.IO server is initializing (check logs)
- Ensure CORS allows WebSocket connections

### Static Files Not Loading

- Verify `dist/client` directory exists in build
- Check that `public/assets` is copied to Docker image
- Ensure static file serving is configured in `src/server/index.ts`

### Session Issues

- Verify `SESSION_SECRET` is set and strong
- Check that cookies are working (HTTPS required in production)
- Ensure session middleware is configured correctly

## Monitoring

Railway provides:

- **Deployment Logs** - View build and runtime logs
- **Metrics** - CPU, memory, and network usage
- **Health Checks** - Automatic monitoring of `/health` endpoint
- **Alerts** - Configure alerts for deployment failures

## Scaling

Railway supports horizontal scaling:

1. Go to your service settings
2. Adjust instance count
3. Railway will automatically distribute traffic

**Note:** Ensure your database connection pool can handle increased connections.

## Backup and Recovery

### Database Backups

Railway PostgreSQL services include automatic backups. To manually backup:

1. Use Railway CLI: `railway run pg_dump`
2. Or connect directly and use `pg_dump`

### Application Data

Game state is stored in PostgreSQL, so database backups include all game data.

## Security Best Practices

1. **Never commit secrets** - Use Railway environment variables
2. **Use strong SESSION_SECRET** - Generate a cryptographically random secret
3. **Enable HTTPS** - Railway provides this automatically
4. **Set CORS correctly** - Never use wildcard (`*`) in production
5. **Review dependencies** - Keep npm packages updated
6. **Use non-root user** - Dockerfile.prod runs as non-root user

## Cost Optimization

- Railway offers a free tier with usage limits
- Monitor your usage in Railway dashboard
- Consider using Railway's sleep feature for development/staging environments
- Optimize Docker image size (already done with multi-stage build)

## Support

- Railway Documentation: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- Railway Status: https://status.railway.app

## Next Steps

After successful deployment:

1. Test all game features
2. Monitor logs for errors
3. Set up custom domain (optional)
4. Configure monitoring alerts
5. Set up staging environment (optional)


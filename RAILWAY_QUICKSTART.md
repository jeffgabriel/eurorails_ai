# Railway Quick Start Checklist

Quick reference for deploying to Railway. See [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md) for detailed instructions.

## Pre-Deployment Checklist

- [ ] Code is pushed to Git repository
- [ ] Railway account created
- [ ] Strong `SESSION_SECRET` generated

## Deployment Steps

1. **Create Railway Project**
   - New Project → Deploy from GitHub
   - Select your repository

2. **Add PostgreSQL Service**
   - + New → Database → Add PostgreSQL
   - Railway provides `DATABASE_URL` automatically

3. **Add Application Service**
   - + New → GitHub Repo
   - Select your repository
   - Railway detects `Dockerfile.prod`

4. **Link Database**
   - App service → Variables → Reference Variable
   - Select PostgreSQL service → `DATABASE_URL`

5. **Set Environment Variables**
   ```
   NODE_ENV=production
   SESSION_SECRET=<your-generated-secret>
   CLIENT_URL=https://<your-app>.up.railway.app
   VITE_API_BASE_URL=https://<your-app>.up.railway.app
   VITE_SOCKET_URL=https://<your-app>.up.railway.app
   ```

6. **First Deployment**
   - Railway builds automatically
   - Wait for deployment to complete
   - Note your Railway domain

7. **Update CORS (After First Deploy)**
   - Update `CLIENT_URL` with your Railway domain
   - Update `VITE_API_BASE_URL` and `VITE_SOCKET_URL`
   - **Rebuild** (push new commit or redeploy)

## Generate Session Secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Verify Deployment

- [ ] Health check: `https://your-app.up.railway.app/health`
- [ ] API test: `https://your-app.up.railway.app/api/test`
- [ ] Database migrations ran (check logs)
- [ ] CORS configured correctly
- [ ] Socket.IO connections work

## Common Issues

**Build fails**: Check build logs, verify all files committed

**Database connection fails**: Verify `DATABASE_URL` is linked correctly

**CORS errors**: Update `CLIENT_URL` and rebuild

**Socket.IO not working**: Verify `VITE_SOCKET_URL` matches your domain

## Files Created for Railway

- `Dockerfile.prod` - Production Docker image
- `railway.json` - Railway service configuration
- `.dockerignore` - Excludes unnecessary files from build
- `RAILWAY_DEPLOYMENT.md` - Complete deployment guide

## Support

See [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md) for detailed troubleshooting and configuration.


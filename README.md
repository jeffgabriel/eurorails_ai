#Intro
This is a test project for building with AI tools. Pretty much everything in this repo was coded by prompting the AI tools, including the rest of this readme. The current result is functional (but very much incomplete) and with little to no attempt to refactor other than what I've asked the AI tools to do.

# Eurorails Digital

A digital implementation of the Eurorails board game using modern web technologies.
## Setup
![](https://drive.google.com/uc?export=view&id=1NQLn-Jin-SRFiVshaIOgHC2k2iw4il0g)

## Track Drawing
![](https://drive.google.com/uc?export=view&id=1iEnhns4--leRVJTqi6qtmn7pvHG-QXSY)

## Manage Load @ City
![](https://drive.google.com/uc?export=view&id=1LLX9KNwIYmOwaUtHTZ_ytHRqi8s_9c46)

## Tech Stack

- **Frontend:**
  - TypeScript
  - Phaser.js
  - HTML5 Canvas
  - Webpack

- **Backend:**
  - Node.js
  - Fastify
  - Socket.IO
  - PostgreSQL

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- npm (v6 or higher)

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd eurorails_ai
```

2. Install dependencies:
```bash
npm install
```

3. Create a PostgreSQL database:
```bash
createdb eurorails
```

4. Configure environment variables:
- Copy `example.env` to `.env`
- Update the values according to your environment

See the [Environment Configuration](#environment-configuration) section for details on all environment variables.

## Development

Run the development server:
```bash
npm run dev
```

This will start:
- Frontend development server at http://localhost:3000
- Backend server at http://localhost:8080

## Building for Production

Build the application:
```bash
npm run build
```

Start the production server:
```bash
npm start
```

### Environment Configuration

The application supports configuration via environment variables for both development and production deployments.

#### Server-Side Configuration

**CORS Configuration:**
- `CLIENT_URL` - Primary client application URL (used for CORS and Socket.IO)
  - In development: defaults to `http://localhost:3000` if not set
  - In production: **MUST** be set to your actual client URL (e.g., `https://app.example.com`)
  
- `ALLOWED_ORIGINS` - Comma-separated list of allowed CORS origins (optional, overrides CLIENT_URL if set)
  - Example: `ALLOWED_ORIGINS=https://app.example.com,https://www.example.com`
  - Useful when multiple domains need API access
  - **Security:** Never use wildcard (`*`) in production without proper authentication

**Other Server Variables:**
- `PORT` - Server port (default: `3001`)
- `NODE_ENV` - Environment mode (`development`, `production`, or `test`)
- `SESSION_SECRET` - Secret key for session encryption (change in production!)

#### Client-Side Configuration (Build-Time)

These variables are injected at build time via webpack:

- `VITE_API_BASE_URL` - Base URL for API requests from the client
  - In development: `http://localhost:3001` (works with webpack proxy)
  - In production: **MUST** be set to your actual API URL (e.g., `https://api.example.com`)
  
- `VITE_SOCKET_URL` - Socket.IO server URL for real-time connections
  - Should match the API server URL in most cases
  - Example: `https://api.example.com`

- `VITE_DEBUG` - Enable debug logging (`true` or `false`, default: `false`)

**Important:** Client-side environment variables must be set **before building** the application. They cannot be changed after the build without rebuilding.

**Recommended:** Always use build-time configuration. Set `VITE_API_BASE_URL` and `VITE_SOCKET_URL` in your environment before running the build command. This ensures the configuration is available immediately on first page load.

#### Runtime Configuration (Not Recommended)

Runtime configuration via `window.__APP_CONFIG__` is supported for edge cases but is **not recommended** because:
- It requires HTML injection which can cause timing issues on first page load
- It adds unnecessary complexity and server-side processing
- Build-time configuration is more reliable and performant

If you must use runtime configuration (e.g., for dynamic deployments), you can inject it:

```javascript
// In your HTML or deployment script
window.__APP_CONFIG__ = {
  apiBaseUrl: 'https://api.example.com',
  socketUrl: 'https://api.example.com',
  debugEnabled: false
};
```

The application checks for runtime config first, then falls back to build-time variables, then defaults. However, **build-time configuration is the primary and recommended method**.

#### Production Deployment Examples

**Single Service (Development):**
```env
CLIENT_URL=http://localhost:3000
VITE_API_BASE_URL=http://localhost:3001
VITE_SOCKET_URL=http://localhost:3001
```

**Separate Services (Production):**
```env
# Server .env
CLIENT_URL=https://app.example.com
ALLOWED_ORIGINS=https://app.example.com,https://www.example.com
PORT=3001

# Client build (set before npm run build)
VITE_API_BASE_URL=https://api.example.com
VITE_SOCKET_URL=https://api.example.com
```

**Security Notes:**
- Always set `CLIENT_URL` or `ALLOWED_ORIGINS` explicitly in production
- Never use wildcard origins (`*`) in production
- Use HTTPS in production
- Set strong `SESSION_SECRET` in production
- Review CORS settings before deploying to production

For complete environment variable documentation, see `example.env` in the project root.

## Project Structure

```
src/
├── client/          # Frontend code
│   ├── components/  # Game components
│   ├── scenes/      # Phaser scenes
│   └── assets/      # Game assets
├── server/          # Backend code
│   ├── routes/      # API routes
│   ├── services/    # Business logic
│   └── db/          # Database operations
└── shared/          # Shared code
    ├── types/       # TypeScript types
    └── utils/       # Utility functions
```

## License

ISC 

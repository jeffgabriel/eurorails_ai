import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import playerRoutes from './routes/playerRoutes';
import trackRoutes from './routes/trackRoutes';
import gameRoutes from './routes/gameRoutes';
import deckRoutes from './routes/deckRoutes';
import loadRoutes from './routes/loadRoutes';
import lobbyRoutes from './routes/lobbyRoutes';
import authRoutes from './routes/authRoutes';
import debugRoutes from './routes/debugRoutes';
import { checkDatabase, db } from './db';
import { PlayerService } from './services/playerService';
import { addRequestId } from './middleware/errorHandler';
import { initializeSocketIO } from './services/socketService';
import { AuthService } from './services/authService';

const app = express();
// Railway provides PORT env var, fallback to 3000 for consistency with Docker health check
const port = parseInt(process.env.PORT || '3001', 10);
const serverPort = parseInt(process.env.SERVER_LOCAL_PORT || '3000', 10);

// Store server instance for health check diagnostics
let httpServer: http.Server | null = null;

// Cache the base HTML template to avoid reading on every request
let cachedHtmlTemplate: string | null = null;

// Configure CORS origins
function getCorsOrigins(): string | string[] {
    // If ALLOWED_ORIGINS is set, use it (comma-separated list)
    if (process.env.ALLOWED_ORIGINS) {
        const origins = process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);
        console.log('CORS: Using ALLOWED_ORIGINS:', origins);
        return origins;
    }
    
    // If CLIENT_URL is set, use it
    if (process.env.CLIENT_URL) {
        console.log('CORS: Using CLIENT_URL:', process.env.CLIENT_URL);
        return process.env.CLIENT_URL;
    }
    
    // In development, default to localhost on the configured server port
    if (process.env.NODE_ENV === 'development') {
        const defaultOrigin = `http://localhost:${serverPort}`;
        console.log('CORS: Using default development origin:', defaultOrigin);
        return defaultOrigin;
    }
    
    // In production, require explicit configuration - fail fast for security
    if (process.env.NODE_ENV === 'production') {
        console.error('========================================');
        console.error('SECURITY ERROR: CORS not configured for production!');
        console.error('Production deployments MUST set CLIENT_URL or ALLOWED_ORIGINS');
        console.error('Falling back to localhost is INSECURE and will block legitimate requests.');
        console.error('========================================');
        // Still return localhost as fallback for backwards compatibility,
        // but log a clear error that this must be fixed
        return `http://localhost:${serverPort}`;
    }
    
    // For test environment or other cases, default to localhost
    console.warn('CORS: No CLIENT_URL or ALLOWED_ORIGINS set. Defaulting to localhost');
    return `http://localhost:${serverPort}`;
}

// Debug logging middleware - add more detail
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Middleware for parsing JSON and serving static files
// CORS configuration - use function to evaluate at request time for dynamic origins
app.use(cors({
    origin: (origin, callback) => {
        const allowedOrigins = getCorsOrigins();
        
        // Log CORS check for debugging
        if (process.env.NODE_ENV === 'production') {
            console.log(`CORS check - Origin: ${origin}, Allowed: ${JSON.stringify(allowedOrigins)}`);
        }
        
        // If no origin (e.g., same-origin request, Postman), allow it
        if (!origin) {
            return callback(null, true);
        }
        
        // Check if origin is in allowed list
        if (Array.isArray(allowedOrigins)) {
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
        } else if (allowedOrigins === origin || allowedOrigins === '*') {
            return callback(null, true);
        }
        
        // Origin not allowed
        console.warn(`CORS blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(addRequestId);

// Session configuration
// Use PostgreSQL store in production, MemoryStore in development
const PgSession = connectPgSimple(session);
let sessionStore: any = undefined;

if (process.env.NODE_ENV === 'production') {
    console.log('=================================');
    console.log('Initializing PostgreSQL Session Store');
    console.log('=================================');
    
    try {
        // connect-pg-simple can use either 'pool' or 'conString'
        // In production (Railway), using DATABASE_URL directly may be more reliable
        const sessionStoreConfig: any = {
            tableName: 'session', // Table name for sessions
            createTableIfMissing: true // Automatically create session table if it doesn't exist
        };
        
        // Prefer DATABASE_URL if available (more reliable in cloud environments like Railway)
        if (process.env.DATABASE_URL) {
            sessionStoreConfig.conString = process.env.DATABASE_URL;
            console.log('Using DATABASE_URL for session store connection');
        } else {
            sessionStoreConfig.pool = db;
            console.log('Using database pool for session store connection');
        }
        
        sessionStore = new PgSession(sessionStoreConfig);
        
        // Log session store configuration
        console.log('Session Store Type: PostgreSQL');
        console.log('Session Table Name: session');
        console.log('Create Table If Missing: true');
        console.log('Database Pool: configured');
        
        // Proactively attempt to create session table if it doesn't exist
        // connect-pg-simple creates tables lazily (on first use), which can cause issues
        // We'll try to create it immediately with retry logic
        const ensureSessionTable = async (retries = 3, delay = 2000): Promise<void> => {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    // Check if table exists
                    const tableCheck = await db.query(`
                        SELECT EXISTS (
                            SELECT FROM information_schema.tables 
                            WHERE table_schema = 'public' 
                            AND table_name = 'session'
                        );
                    `);
                    const tableExists = tableCheck.rows[0].exists;
                    
                    if (tableExists) {
                        console.log(`✓ Session table verified in database (attempt ${attempt}/${retries})`);
                        return;
                    }
                    
                    // Table doesn't exist - try to create it
                    console.log(`Attempting to create session table (attempt ${attempt}/${retries})...`);
                    await db.query(`
                        CREATE TABLE IF NOT EXISTS "session" (
                          "sid" varchar NOT NULL COLLATE "default",
                          "sess" json NOT NULL,
                          "expire" timestamp(6) NOT NULL
                        )
                        WITH (OIDS=FALSE);
                    `);
                    
                    // Add primary key if it doesn't exist
                    await db.query(`
                        DO $$
                        BEGIN
                            IF NOT EXISTS (
                                SELECT 1 FROM pg_constraint 
                                WHERE conname = 'session_pkey' 
                                AND conrelid = 'session'::regclass
                            ) THEN
                                ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
                            END IF;
                        END $$;
                    `);
                    
                    // Create index if it doesn't exist
                    await db.query(`
                        CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
                    `);
                    
                    // Verify it was created
                    const verifyCheck = await db.query(`
                        SELECT EXISTS (
                            SELECT FROM information_schema.tables 
                            WHERE table_schema = 'public' 
                            AND table_name = 'session'
                        );
                    `);
                    
                    if (verifyCheck.rows[0].exists) {
                        console.log(`✓ Session table created successfully (attempt ${attempt}/${retries})`);
                        return;
                    } else {
                        throw new Error('Table creation completed but table still does not exist');
                    }
                } catch (error: any) {
                    const isLastAttempt = attempt === retries;
                    if (isLastAttempt) {
                        console.error(`✗ Failed to create session table after ${retries} attempts`);
                        console.error(`  Error: ${error.message}`);
                        console.error(`  Code: ${error.code || 'unknown'}`);
                        if (error.code === '42501') {
                            console.error('  This appears to be a database permissions issue (CREATE TABLE permission denied)');
                            console.error('  The database user needs CREATE TABLE privileges on the public schema');
                        }
                        console.error('  Sessions may not persist across server restarts');
                    } else {
                        console.warn(`⚠ Session table creation failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`);
                        console.warn(`  Error: ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        delay *= 2; // Exponential backoff
                    }
                }
            }
        };
        
        // Start table creation check after a short delay to ensure DB connection is ready
        setTimeout(() => {
            ensureSessionTable().catch((error) => {
                console.error('Unhandled error in ensureSessionTable:', error);
            });
        }, 1000);
        
        // Add error handlers to session store
        if (sessionStore && typeof sessionStore.on === 'function') {
            sessionStore.on('connect', () => {
                console.log('✓ Session store connected to database');
            });
            
            sessionStore.on('error', (error: any) => {
                console.error('✗ Session store error:', error);
                console.error('  Stack:', error.stack);
            });
        }
        
        // Verify session store is actually a PostgreSQL store (not MemoryStore)
        const storeType = sessionStore?.constructor?.name || 'Unknown';
        console.log(`Session Store Instance Type: ${storeType}`);
        if (!storeType.includes('Pg') && !storeType.includes('Postgres')) {
            console.error('⚠ WARNING: Session store does not appear to be PostgreSQL store!');
            console.error(`  Expected: PgStore or similar, Got: ${storeType}`);
        }
        
        // Test session store by attempting to query the session table
        setTimeout(async () => {
            try {
                const testQuery = await db.query('SELECT COUNT(*) as count FROM session LIMIT 1');
                console.log(`✓ Session store database connection verified (${testQuery.rows[0].count} existing sessions)`);
            } catch (error: any) {
                console.error('✗ WARNING: Cannot query session table:', error.message);
                console.error('  This may indicate the session store is not properly connected');
            }
        }, 3000); // Check after table creation completes
        
        console.log('=================================');
    } catch (error: any) {
        console.error('=================================');
        console.error('CRITICAL: Failed to initialize PostgreSQL session store');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('=================================');
        console.error('Falling back to MemoryStore (sessions will not persist across restarts)');
        console.error('=================================');
        sessionStore = undefined; // Fall back to MemoryStore
    }
} else {
    console.log('Session Store Type: MemoryStore (development mode)');
    console.log('Note: Sessions will not persist across server restarts');
}

// Session middleware configuration
const sessionSecret = process.env.SESSION_SECRET || 'your-secret-key';
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.warn('⚠ WARNING: SESSION_SECRET not set in production! Using default secret (INSECURE)');
}

app.use(session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // Allow cross-site cookies in production (for Railway)
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    },
    name: 'eurorails.sid' // Custom session cookie name
}));

// Log cookie configuration
console.log('Session Cookie Configuration:');
console.log(`  Secure: ${process.env.NODE_ENV === 'production'}`);
console.log(`  HttpOnly: true`);
console.log(`  SameSite: ${process.env.NODE_ENV === 'production' ? 'none' : 'lax'}`);
console.log(`  MaxAge: 24 hours`);
console.log(`  Name: eurorails.sid`);

// Add session error handling middleware
app.use((req, res, next) => {
    // Wrap session.save to catch errors and verify database writes
    const originalSave = req.session.save.bind(req.session);
    (req.session as any).save = function(callback?: (err?: any) => void) {
        const sessionId = req.sessionID;
        const storeType = (req.session as any).store?.constructor?.name || 'Unknown';
        
        originalSave(async (err?: any) => {
            if (err) {
                console.error('Session save error:', err);
                console.error('  Session ID:', sessionId);
                console.error('  Request ID:', req.requestId);
                console.error('  User ID:', (req as any).user?.id || 'not authenticated');
                console.error('  Store Type:', storeType);
                console.error('  Stack:', err.stack);
            } else {
                // Verify session was saved to database (only in production with PostgreSQL store)
                if (process.env.NODE_ENV === 'production' && storeType.includes('Pg')) {
                    try {
                        const verifyQuery = await db.query('SELECT sid FROM session WHERE sid = $1 LIMIT 1', [sessionId]);
                        if (verifyQuery.rows.length === 0) {
                            console.error('⚠ WARNING: Session save succeeded but session not found in database!');
                            console.error('  Session ID:', sessionId);
                            console.error('  Store Type:', storeType);
                            console.error('  This indicates the session store may not be working correctly');
                        }
                    } catch (verifyError: any) {
                        // Don't log verify errors in production unless debug is enabled
                        if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
                            console.warn('Could not verify session in database:', verifyError.message);
                        }
                    }
                }
            }
            if (callback) callback(err);
        });
    };
    next();
});

// Add middleware to restore game ID from active game if session is lost
// IMPORTANT: Only restore gameId if user is authenticated AND has a player in that game
// This prevents all users from being assigned to the same game
app.use(async (req, res, next) => {
    const requestId = req.requestId || 'unknown';
    const sessionId = req.sessionID;
    
    // Extract userId from JWT token if present (similar to optionalAuth)
    // This works even though req.user isn't populated yet (that happens in route-specific middleware)
    let userId: string | undefined = undefined;
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
        
        if (token) {
            const payload = AuthService.verifyToken(token);
            if (payload) {
                userId = payload.userId;
            }
        }
    } catch (error) {
        // Silently fail - if token extraction fails, userId remains undefined
        // This is fine since we only restore gameId for authenticated users
    }
    
    // Only restore gameId if session doesn't have one
    if (!req.session.gameId) {
        try {
            // Only restore gameId for authenticated users
            if (!userId) {
                // Log that we're skipping restoration for unauthenticated users
                // Show logs in development OR when debug routes are explicitly enabled
                if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEBUG_ROUTES === 'true') {
                    console.log(`[Session Restore] Skipping gameId restoration - user not authenticated (Request ID: ${requestId}, Session ID: ${sessionId})`);
                }
                return next();
            }
            
            // Get active game using the imported PlayerService
            const activeGame = await PlayerService.getActiveGame();
            
            if (activeGame) {
                // CRITICAL FIX: Only assign gameId if this user has a player in the active game
                // This prevents all users from being assigned to the same game
                const playerCheck = await db.query(
                    'SELECT id FROM players WHERE game_id = $1 AND user_id = $2 LIMIT 1',
                    [activeGame.id, userId]
                );
                
                if (playerCheck.rows.length > 0) {
                    // User has a player in this game - safe to restore gameId
                    const playerId = playerCheck.rows[0].id;
                    req.session.gameId = activeGame.id;
                    
                    console.log(`[Session Restore] Restored gameId for authenticated user (User ID: ${userId}, Player ID: ${playerId}, Game ID: ${activeGame.id}, Request ID: ${requestId})`);
                    
                    await new Promise<void>((resolve, reject) => {
                        req.session.save((err) => {
                            if (err) {
                                console.error(`[Session Restore] Failed to save session after gameId restoration (Request ID: ${requestId}):`, err);
                                reject(err);
                            } else {
                                console.log(`[Session Restore] Session saved successfully (Request ID: ${requestId})`);
                                resolve();
                            }
                        });
                    });
                } else {
                    // User does not have a player in the active game - do NOT assign gameId
                    // This is the fix for the bug where all users were seeing the same lobby
                    // Show logs in development OR when debug routes are explicitly enabled
                    if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEBUG_ROUTES === 'true') {
                        console.log(`[Session Restore] Active game found but user is not a player (User ID: ${userId}, Game ID: ${activeGame.id}, Request ID: ${requestId})`);
                    }
                }
            } else {
                // No active game found
                // Show logs in development OR when debug routes are explicitly enabled
                if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEBUG_ROUTES === 'true') {
                    console.log(`[Session Restore] No active game found (User ID: ${userId}, Request ID: ${requestId})`);
                }
            }
        } catch (error: any) {
            console.error(`[Session Restore] Error restoring game ID from active game (Request ID: ${requestId}):`, error);
            console.error('  Stack:', error.stack);
            // Don't block the request - continue even if restoration fails
        }
    } else {
        // Session already has gameId - log for debugging if enabled
        // Show logs in development OR when debug routes are explicitly enabled
        if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEBUG_ROUTES === 'true') {
            console.log(`[Session Restore] Session already has gameId (Game ID: ${req.session.gameId}, User ID: ${userId || 'not authenticated'}, Request ID: ${requestId})`);
        }
    }
    next();
});

// API Routes - make sure this comes before static file serving
app.use('/api/auth', authRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/tracks', trackRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/deck', deckRoutes);
app.use('/api/loads', loadRoutes);
app.use('/api/lobby', lobbyRoutes);

// Debug routes - only enabled when ENABLE_DEBUG_ROUTES=true
// These routes are protected by the checkDebugEnabled middleware in debugRoutes.ts
if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
    console.log('=================================');
    console.log('Debug routes ENABLED');
    console.log('Available endpoints:');
    console.log('  GET  /api/debug/session - Current session info');
    console.log('  GET  /api/debug/session-table - Session table schema & permissions');
    console.log('  GET  /api/debug/sessions - List all sessions');
    console.log('  POST /api/debug/session/test - Test session write/read');
    console.log('  GET  /api/debug/session-store-info - Session store config');
    console.log('  GET  /api/debug/db-permissions - Check database permissions');
    console.log('  POST /api/debug/create-session-table - Manually create session table');
    console.log('=================================');
    app.use('/api/debug', debugRoutes);
} else {
    console.log('Debug routes DISABLED (set ENABLE_DEBUG_ROUTES=true to enable)');
}

// Log registered routes
console.log('Registered routes:');
app._router.stack.forEach((r: any) => {
    if (r.route && r.route.path) {
        console.log(`Route: ${Object.keys(r.route.methods)} ${r.route.path}`);
    } else if (r.name === 'router') {
        console.log('Router middleware:', r.regexp);
    }
});

// Static file serving
app.use(express.static(path.join(__dirname, '../../dist/client')));
// Also serve public assets
app.use('/assets', express.static(path.join(__dirname, '../../public/assets')));

// Debug endpoint
app.get('/api/test', (req, res) => {
    res.json({ message: 'API is working' });
});

// Helper function to make internal HTTP request
async function testInternalEndpoint(url: string, timeout: number = 2000): Promise<{ success: boolean; statusCode?: number; error?: string; duration?: number }> {
    const startTime = Date.now();
    return new Promise((resolve) => {
        const request = http.get(url, { timeout }, (response) => {
            const duration = Date.now() - startTime;
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                resolve({
                    success: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300,
                    statusCode: response.statusCode,
                    duration
                });
            });
        });
        
        request.on('error', (err: any) => {
            const duration = Date.now() - startTime;
            resolve({
                success: false,
                error: err.message || 'Unknown error',
                duration
            });
        });
        
        request.on('timeout', () => {
            request.destroy();
            const duration = Date.now() - startTime;
            resolve({
                success: false,
                error: 'Request timeout',
                duration
            });
        });
    });
}

// Health check endpoint for Railway and monitoring
app.get('/health', async (req, res) => {
    // Diagnostic information to help debug 502 errors on root path
    const indexPath = path.join(__dirname, '../../dist/client/index.html');
    const clientDistPath = path.join(__dirname, '../../dist/client');
    
    let fileExists = false;
    let fileError: string | null = null;
    let dirExists = false;
    let dirError: string | null = null;
    
    // Check if index.html exists
    try {
        await fs.promises.access(indexPath, fs.constants.F_OK);
        fileExists = true;
    } catch (err: any) {
        fileError = err.message || 'Unknown error';
    }
    
    // Check if dist/client directory exists
    try {
        await fs.promises.access(clientDistPath, fs.constants.F_OK);
        dirExists = true;
    } catch (err: any) {
        dirError = err.message || 'Unknown error';
    }
    
    // Test internal endpoints to see if routes are working
    // Use 127.0.0.1 for internal requests (more reliable than localhost)
    // Use shorter timeout (1s each) to stay within Docker HEALTHCHECK timeout (3s)
    const internalHost = '127.0.0.1';
    const serverUrl = `http://${internalHost}:${port}`;
    const rootPathTest = await testInternalEndpoint(`${serverUrl}/`, 1000);
    const apiTestTest = await testInternalEndpoint(`${serverUrl}/api/test`, 1000);
    
    // Build diagnostics object
    const diagnostics = {
        indexHtml: {
            exists: fileExists,
            path: indexPath,
            resolvedPath: path.resolve(indexPath),
            error: fileError
        },
        clientDist: {
            exists: dirExists,
            path: clientDistPath,
            resolvedPath: path.resolve(clientDistPath),
            error: dirError
        },
        serverInfo: {
            __dirname: __dirname,
            cwd: process.cwd(),
            nodeEnv: process.env.NODE_ENV,
            port: port,
            serverAddress: httpServer?.address() || null,
            envVars: {
                CLIENT_URL: process.env.CLIENT_URL || '(not set)',
                VITE_API_BASE_URL: process.env.VITE_API_BASE_URL || '(not set)',
                VITE_SOCKET_URL: process.env.VITE_SOCKET_URL || '(not set)',
                PORT: process.env.PORT || '(not set)',
                NODE_ENV: process.env.NODE_ENV || '(not set)'
            }
        },
        endpointTests: {
            rootPath: {
                url: `${serverUrl}/`,
                ...rootPathTest
            },
            apiTest: {
                url: `${serverUrl}/api/test`,
                ...apiTestTest
            }
        }
    };
    
    // Log diagnostics to stdout for Railway logs
    console.log('=================================');
    console.log('HEALTH CHECK DIAGNOSTICS:');
    console.log('=================================');
    console.log('File System Checks:');
    console.log(`  index.html exists: ${fileExists}`);
    console.log(`  index.html path: ${path.resolve(indexPath)}`);
    if (fileError) console.log(`  index.html error: ${fileError}`);
    console.log(`  dist/client exists: ${dirExists}`);
    console.log(`  dist/client path: ${path.resolve(clientDistPath)}`);
    if (dirError) console.log(`  dist/client error: ${dirError}`);
    console.log('');
    console.log('Server Info:');
    console.log(`  __dirname: ${__dirname}`);
    console.log(`  cwd: ${process.cwd()}`);
    console.log(`  port: ${port}`);
    console.log(`  server address: ${JSON.stringify(httpServer?.address())}`);
    console.log('');
    console.log('Environment Variables:');
    console.log(`  CLIENT_URL: ${process.env.CLIENT_URL || '(not set)'}`);
    console.log(`  VITE_API_BASE_URL: ${process.env.VITE_API_BASE_URL || '(not set)'}`);
    console.log(`  VITE_SOCKET_URL: ${process.env.VITE_SOCKET_URL || '(not set)'}`);
    console.log(`  PORT: ${process.env.PORT || '(not set)'}`);
    console.log(`  NODE_ENV: ${process.env.NODE_ENV || '(not set)'}`);
    console.log('');
    console.log('Endpoint Tests:');
    console.log(`  Root path (${serverUrl}/): ${rootPathTest.success ? 'SUCCESS' : 'FAILED'}`);
    if (rootPathTest.statusCode) console.log(`    Status: ${rootPathTest.statusCode}`);
    if (rootPathTest.error) console.log(`    Error: ${rootPathTest.error}`);
    if (rootPathTest.duration) console.log(`    Duration: ${rootPathTest.duration}ms`);
    console.log(`  API test (${serverUrl}/api/test): ${apiTestTest.success ? 'SUCCESS' : 'FAILED'}`);
    if (apiTestTest.statusCode) console.log(`    Status: ${apiTestTest.statusCode}`);
    if (apiTestTest.error) console.log(`    Error: ${apiTestTest.error}`);
    if (apiTestTest.duration) console.log(`    Duration: ${apiTestTest.duration}ms`);
    console.log('=================================');
    
    // Always return 200 so Railway doesn't restart, but include diagnostics
    res.status(200).json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        diagnostics: diagnostics
    });
});

// SPA fallback - this should come after all other routes
app.get('*', async (req, res, next) => {
    // Skip if this is an API route
    if (req.path.startsWith('/api/')) {
        return next();
    }
    
    // Skip if this is an asset route
    if (req.path.startsWith('/assets/')) {
        return next();
    }
    
    // Skip if this is a static file (has file extension)
    if (req.path.includes('.')) {
        return next();
    }
    
    const indexPath = path.join(__dirname, '../../dist/client/index.html');
    
    // Inject runtime configuration for API URLs
    // This allows the client to use the correct API URL even if build-time vars weren't set
    try {
        // Use cached template if available, otherwise read from disk
        let htmlContent = cachedHtmlTemplate;
        if (!htmlContent) {
            htmlContent = await fs.promises.readFile(indexPath, 'utf-8');
            cachedHtmlTemplate = htmlContent; // Cache for future requests
        }
        
        // Determine API base URL from environment or request origin
        // In production, use the same origin as the request (same domain)
        // This ensures the client uses the correct API URL without CORS issues
        const requestOrigin = req.protocol + '://' + req.get('host');
        const apiBaseUrl = process.env.VITE_API_BASE_URL || 
                          process.env.CLIENT_URL || 
                          requestOrigin;
        const socketUrl = process.env.VITE_SOCKET_URL || apiBaseUrl;
        
        // Log the API URL being injected for debugging
        console.log('[Config Injection] API Base URL:', apiBaseUrl);
        console.log('[Config Injection] Request origin:', requestOrigin);
        console.log('[Config Injection] VITE_API_BASE_URL env:', process.env.VITE_API_BASE_URL || '(not set)');
        console.log('[Config Injection] CLIENT_URL env:', process.env.CLIENT_URL || '(not set)');
        
        // Inject runtime config script as the FIRST script in <head>
        // This ensures it executes before any other scripts that might need the config
        const configScript = `<script type="text/javascript">
        // Runtime configuration injection - must execute before other scripts
        window.__APP_CONFIG__ = {
            apiBaseUrl: ${JSON.stringify(apiBaseUrl)},
            socketUrl: ${JSON.stringify(socketUrl)},
            debugEnabled: ${process.env.VITE_DEBUG === 'true' ? 'true' : 'false'}
        };
        console.log('[Runtime Config] Injected API base URL:', window.__APP_CONFIG__.apiBaseUrl);
    </script>`;
        
        // Insert config script as early as possible in <head>
        // Try to insert right after <head> tag, or before </head> if no opening tag found
        let modifiedHtml: string;
        if (htmlContent.includes('<head>')) {
            // Insert right after <head> tag to ensure it executes first
            modifiedHtml = htmlContent.replace('<head>', '<head>' + configScript);
        } else if (htmlContent.includes('</head>')) {
            // Fallback: insert before </head>
            modifiedHtml = htmlContent.replace('</head>', configScript + '\n</head>');
        } else if (htmlContent.includes('</body>')) {
            // Last resort: insert before </body>
            modifiedHtml = htmlContent.replace('</body>', configScript + '\n</body>');
        } else {
            // No standard tags found, prepend to content
            modifiedHtml = configScript + '\n' + htmlContent;
        }
        
        res.send(modifiedHtml);
    } catch (err: any) {
        console.error('Error reading/injecting index.html:', err);
        
        // Fallback to sendFile if injection fails
        res.sendFile(indexPath, (sendFileErr) => {
            if (sendFileErr) {
                console.error('Error serving index.html:', sendFileErr);
                console.error('Request path:', req.path);
                console.error('Resolved index.html path:', path.resolve(indexPath));
                
                if (res.headersSent) {
                    console.error('Headers already sent, closing connection');
                    return res.end();
                }
                
                const statusCode = (sendFileErr as any).status || 500;
                res.status(statusCode).json({
                    error: 'Failed to serve application',
                    message: sendFileErr.message || 'Internal server error',
                    path: req.path
                });
            }
        });
    }
});

// Initialize database and start server
async function startServer() {
    try {
        // Check database connection and schema
        const dbReady = await checkDatabase();
        if (!dbReady) {
            console.error('Database initialization failed');
            process.exit(1);
        }

        // Initialize default game
        try {
            const gameId = await PlayerService.initializeDefaultGame();
            console.log('Default game initialized with ID:', gameId);
        } catch (err) {
            console.error('Failed to initialize default game:', err);
            // Don't exit - the game might already exist
        }

        // Create HTTP server
        const server = http.createServer(app);
        httpServer = server; // Store for health check diagnostics

        // Initialize Socket.IO with error handling
        try {
            initializeSocketIO(server);
        } catch (error) {
            console.error('Failed to initialize Socket.IO:', error);
            // Continue server startup even if Socket.IO fails
            // This allows the app to run without real-time features
        }

        // Start server - explicitly bind to 0.0.0.0 to accept connections from Railway
        server.listen(port, '0.0.0.0', () => {
            console.log('=================================');
            console.log(`Server running in ${process.env.NODE_ENV} mode`);
            console.log(`API server listening on port ${port} (bound to 0.0.0.0)`);
            console.log(`Socket.IO initialized and ready`);
            console.log(`API routes available at http://localhost:${port}/api`);
            console.log('In development mode:');
            console.log('- Client dev server runs on port 3000');
            console.log('- API requests are proxied from port 3000 to 3001');
            console.log('Database connection established');
            console.log('=================================');
        });

        // Log when server closes
        server.on('close', () => {
            console.log('Server shutting down');
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Add error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({
        message: err.message || 'Internal server error'
    });
});

startServer(); 
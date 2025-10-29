import express from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import session from 'express-session';
import playerRoutes from './routes/playerRoutes';
import trackRoutes from './routes/trackRoutes';
import gameRoutes from './routes/gameRoutes';
import deckRoutes from './routes/deckRoutes';
import loadRoutes from './routes/loadRoutes';
import lobbyRoutes from './routes/lobbyRoutes';
import authRoutes from './routes/authRoutes';
import { checkDatabase } from './db';
import { PlayerService } from './services/playerService';
import { addRequestId } from './middleware/errorHandler';
import { initializeSocketIO } from './services/socketService';

const app = express();
const port = process.env.PORT || 3001;
const serverPort = process.env.SERVER_LOCAL_PORT || 3000;
// Debug logging middleware - add more detail
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Middleware for parsing JSON and serving static files
app.use(cors({
    origin: `http://localhost:${serverPort}`,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(addRequestId);

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Add middleware to restore game ID from active game if session is lost
app.use(async (req, res, next) => {
    if (!req.session.gameId) {
        try {
            const PlayerService = require('./services/playerService').PlayerService;
            const activeGame = await PlayerService.getActiveGame();
            if (activeGame) {
                // Verify game has valid players
                const players = await PlayerService.getPlayers(activeGame.id);
                if (players && players.length > 0) {
                    req.session.gameId = activeGame.id;
                    await new Promise<void>((resolve, reject) => {
                        req.session.save((err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                } else {
                    // No valid players, mark game as interrupted
                    await PlayerService.updateGameStatus(activeGame.id, 'interrupted');
                }
            }
        } catch (error) {
            console.error('Error restoring game ID from active game:', error);
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

// SPA fallback - this should come after all other routes
app.get('*', (req, res, next) => {
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
    
    res.sendFile(path.join(__dirname, '../../dist/client/index.html'));
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

        // Initialize Socket.IO
        initializeSocketIO(server);

        // Start server
        server.listen(port, () => {
            console.log('=================================');
            console.log(`Server running in ${process.env.NODE_ENV} mode`);
            console.log(`API server listening on port ${port}`);
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
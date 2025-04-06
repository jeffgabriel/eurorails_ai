import express from 'express';
import path from 'path';
import cors from 'cors';
import playerRoutes from './routes/playerRoutes';
import trackRoutes from './routes/trackRoutes';
import gameRoutes from './routes/gameRoutes';
import { checkDatabase } from './db';
import { PlayerService } from './services/playerService';

const app = express();
const port = process.env.PORT || 3001;

// Debug logging middleware - add more detail
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    console.log('Headers:', req.headers);
    if (req.body && Object.keys(req.body).length > 0) {
        console.log('Body:', req.body);
    }
    next();
});

// Middleware for parsing JSON and serving static files
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes - make sure this comes before static file serving
app.use('/api/players', playerRoutes);
app.use('/api/tracks', trackRoutes);
app.use('/api/game', gameRoutes);

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

// SPA fallback - this should come after API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../dist/client/index.html'));
});

// Debug endpoint
app.get('/api/test', (req, res) => {
    res.json({ message: 'API is working' });
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

        // Start server
        const server = app.listen(port, () => {
            console.log('=================================');
            console.log(`Server running in ${process.env.NODE_ENV} mode`);
            console.log(`API server listening on port ${port}`);
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
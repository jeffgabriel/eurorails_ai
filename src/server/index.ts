import { createServer } from 'http';
import { Server } from 'socket.io';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const Pool = pg.Pool;
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ES Module dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create HTTP server with request handler
const httpServer = createServer((req, res) => {
    if (req.url === '/') {
        // Serve the index.html file
        fs.readFile(path.join(__dirname, '../../dist/client/index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/bundle.js') {
        // Serve the webpack bundle
        fs.readFile(path.join(__dirname, '../../dist/client/bundle.js'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading bundle.js');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Create Socket.IO server
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Database connection
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'eurorails',
    password: process.env.DB_PASSWORD || 'postgres',
    port: parseInt(process.env.DB_PORT || '5432')
});

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Start the server
const PORT = parseInt(process.env.PORT || '8080');
httpServer.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    
    // Test database connection
    pool.connect()
        .then((client) => {
            console.log('Successfully connected to PostgreSQL');
            client.release();
        })
        .catch((error: Error) => {
            console.error('Database connection error:', error);
            process.exit(1);
        });
}); 
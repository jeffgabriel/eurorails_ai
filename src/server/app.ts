import express from 'express';
import path from 'path';
import gameRoutes from './routes/gameRoutes';
import loadRoutes from './routes/loadRoutes';

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../public')));

// Routes
app.use('/api/game', gameRoutes);
app.use('/api/loads', loadRoutes);

export default app; 
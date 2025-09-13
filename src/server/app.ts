import express from 'express';
import path from 'path';
import gameRoutes from './routes/gameRoutes';
import loadRoutes from './routes/loadRoutes';
import lobbyRoutes from './routes/lobbyRoutes';
import { 
  addRequestId, 
  errorHandler, 
  notFoundHandler 
} from './middleware/errorHandler';
import { requestLoggingMiddleware } from './middleware/requestLogger';

const app = express();

// Request ID middleware (must be first)
app.use(addRequestId);

// Request logging middleware
app.use(requestLoggingMiddleware);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, '../../public')));

// API Routes
app.use('/api/game', gameRoutes);
app.use('/api/loads', loadRoutes);
app.use('/api/lobby', lobbyRoutes);

// 404 handler for unmatched routes
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

export default app; 
import { Request, Response, NextFunction } from 'express';
import { LobbyError } from '../services/lobbyService';
import { requestLogger } from './requestLogger';

// Error response interface
interface ErrorResponse {
  error: string;
  message: string;
  details?: string;
  timestamp: string;
  path: string;
  method: string;
  requestId?: string;
}

// Request ID generator (simple UUID v4 implementation)
function generateRequestId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Add request ID to requests
export function addRequestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = generateRequestId();
  res.setHeader('X-Request-ID', req.requestId);
  next();
}

// Main error handling middleware
export function errorHandler(error: any, req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  const timestamp = new Date().toISOString();
  const path = req.path;
  const method = req.method;

  // Log error details using structured logging
  requestLogger.error(`Error in ${method} ${path}`, {
    error: error.message,
    stack: error.stack,
    method,
    path,
    body: req.body,
    query: req.query,
    params: req.params
  }, requestId);

  // Handle different error types
  let statusCode: number;
  let errorCode: string;
  let message: string;
  let details: string | undefined;

  if (error instanceof LobbyError) {
    // Custom lobby errors
    statusCode = error.statusCode;
    errorCode = error.code;
    message = error.message;
    details = error.message;
  } else if (error.name === 'ValidationError') {
    // Joi or other validation errors
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = 'Invalid request data';
    details = error.details?.map((d: any) => d.message).join(', ') || error.message;
  } else if (error.name === 'CastError') {
    // MongoDB/ObjectId casting errors
    statusCode = 400;
    errorCode = 'INVALID_ID';
    message = 'Invalid ID format';
    details = error.message;
  } else if (error.name === 'SyntaxError' && error.type === 'entity.parse.failed') {
    // JSON parsing errors
    statusCode = 400;
    errorCode = 'INVALID_JSON';
    message = 'Invalid JSON in request body';
    details = 'Request body must be valid JSON';
  } else if (error.code === 'ECONNREFUSED') {
    // Database connection errors
    statusCode = 503;
    errorCode = 'DATABASE_UNAVAILABLE';
    message = 'Database service unavailable';
    details = 'Unable to connect to database';
  } else if (error.code === 'ENOTFOUND') {
    // DNS resolution errors
    statusCode = 503;
    errorCode = 'SERVICE_UNAVAILABLE';
    message = 'External service unavailable';
    details = 'Unable to resolve external service';
  } else if (error instanceof Error) {
    // Generic error
    statusCode = 500;
    errorCode = 'INTERNAL_SERVER_ERROR';
    message = 'An unexpected error occurred';
    details = process.env.NODE_ENV === 'development' ? error.message : undefined;
  } else {
    // Unknown error type
    statusCode = 500;
    errorCode = 'UNKNOWN_ERROR';
    message = 'An unexpected error occurred';
    details = 'Unknown error type';
  }

  // Create error response
  const errorResponse: ErrorResponse = {
    error: errorCode,
    message,
    details,
    timestamp,
    path,
    method,
    requestId
  };

  // Send error response
  res.status(statusCode).json(errorResponse);
}

// 404 handler for unmatched routes
export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  const timestamp = new Date().toISOString();
  
  requestLogger.warn(`404 - Route not found: ${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    query: req.query
  }, requestId);

  const errorResponse: ErrorResponse = {
    error: 'NOT_FOUND',
    message: 'Route not found',
    details: `No route found for ${req.method} ${req.path}`,
    timestamp,
    path: req.path,
    method: req.method,
    requestId
  };

  res.status(404).json(errorResponse);
}

// Async error wrapper for route handlers
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Rate limiting error handler
export function rateLimitHandler(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  const timestamp = new Date().toISOString();
  
  console.warn(`[${timestamp}] [${requestId}] Rate limit exceeded: ${req.method} ${req.path}`);

  const errorResponse: ErrorResponse = {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests',
    details: 'Rate limit exceeded. Please try again later.',
    timestamp,
    path: req.path,
    method: req.method,
    requestId
  };

  res.status(429).json(errorResponse);
}

// Health check error handler
export function healthCheckErrorHandler(error: any, req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  const timestamp = new Date().toISOString();
  
  console.error(`[${timestamp}] [${requestId}] Health check error:`, error);

  const errorResponse: ErrorResponse = {
    error: 'HEALTH_CHECK_FAILED',
    message: 'Health check failed',
    details: error.message,
    timestamp,
    path: req.path,
    method: req.method,
    requestId
  };

  res.status(503).json(errorResponse);
}

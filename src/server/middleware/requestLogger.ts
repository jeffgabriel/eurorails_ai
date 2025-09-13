import { Request, Response, NextFunction } from 'express';

// Log levels
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

// Request logging interface
interface RequestLogData {
  requestId: string;
  method: string;
  url: string;
  path: string;
  query: any;
  body?: any;
  headers: any;
  userAgent?: string;
  ip?: string;
  timestamp: string;
  duration?: number;
  statusCode?: number;
  responseSize?: number;
}

// Response logging interface
interface ResponseLogData {
  requestId: string;
  statusCode: number;
  responseTime: number;
  responseSize?: number;
  error?: string;
}

// Log entry interface
interface LogEntry {
  level: LogLevel;
  message: string;
  data?: any;
  timestamp: string;
  requestId?: string;
  service: string;
}

class RequestLogger {
  private serviceName: string;

  constructor(serviceName: string = 'lobby-api') {
    this.serviceName = serviceName;
  }

  // Create a log entry
  private createLogEntry(level: LogLevel, message: string, data?: any, requestId?: string): LogEntry {
    return {
      level,
      message,
      data,
      timestamp: new Date().toISOString(),
      requestId,
      service: this.serviceName
    };
  }

  // Log a message
  private log(level: LogLevel, message: string, data?: any, requestId?: string): void {
    const logEntry = this.createLogEntry(level, message, data, requestId);
    
    // Format log output based on level
    const logMessage = `[${logEntry.timestamp}] [${logEntry.level}] [${logEntry.service}]${requestId ? ` [${requestId}]` : ''} ${message}`;
    
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(logMessage, data ? JSON.stringify(data, null, 2) : '');
        break;
      case LogLevel.INFO:
        console.info(logMessage, data ? JSON.stringify(data, null, 2) : '');
        break;
      case LogLevel.WARN:
        console.warn(logMessage, data ? JSON.stringify(data, null, 2) : '');
        break;
      case LogLevel.ERROR:
        console.error(logMessage, data ? JSON.stringify(data, null, 2) : '');
        break;
    }
  }

  // Public logging methods
  public debug(message: string, data?: any, requestId?: string): void {
    this.log(LogLevel.DEBUG, message, data, requestId);
  }

  public info(message: string, data?: any, requestId?: string): void {
    this.log(LogLevel.INFO, message, data, requestId);
  }

  public warn(message: string, data?: any, requestId?: string): void {
    this.log(LogLevel.WARN, message, data, requestId);
  }

  public error(message: string, data?: any, requestId?: string): void {
    this.log(LogLevel.ERROR, message, data, requestId);
  }

  // Request logging methods
  public logRequest(req: Request, res: Response, next: NextFunction): void {
    const requestId = req.requestId || 'unknown';
    const startTime = Date.now();
    
    // Store start time for duration calculation
    (req as any).startTime = startTime;

    const requestData: RequestLogData = {
      requestId,
      method: req.method,
      url: req.url,
      path: req.path,
      query: req.query,
      body: this.sanitizeBody(req.body),
      headers: this.sanitizeHeaders(req.headers),
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection.remoteAddress,
      timestamp: new Date().toISOString()
    };

    this.info('Incoming request', requestData, requestId);

    // Log response when it finishes
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const responseData: ResponseLogData = {
        requestId,
        statusCode: res.statusCode,
        responseTime: duration,
        responseSize: res.get('Content-Length') ? parseInt(res.get('Content-Length')!) : undefined
      };

      const level = res.statusCode >= 400 ? LogLevel.ERROR : LogLevel.INFO;
      this.log(level, 'Request completed', responseData, requestId);
    });

    next();
  }

  // Sanitize request body to remove sensitive data
  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') {
      return body;
    }

    const sanitized = { ...body };
    const sensitiveFields = ['password', 'token', 'secret', 'key', 'auth'];
    
    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  // Sanitize headers to remove sensitive data
  private sanitizeHeaders(headers: any): any {
    if (!headers || typeof headers !== 'object') {
      return headers;
    }

    const sanitized = { ...headers };
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'x-auth-token'];
    
    for (const header of sensitiveHeaders) {
      if (sanitized[header]) {
        sanitized[header] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  // Log API operation
  public logApiOperation(operation: string, data?: any, requestId?: string): void {
    this.info(`API Operation: ${operation}`, data, requestId);
  }

  // Log database operation
  public logDatabaseOperation(operation: string, data?: any, requestId?: string): void {
    this.debug(`Database Operation: ${operation}`, data, requestId);
  }

  // Log business logic operation
  public logBusinessOperation(operation: string, data?: any, requestId?: string): void {
    this.info(`Business Logic: ${operation}`, data, requestId);
  }
}

// Create singleton instance
export const requestLogger = new RequestLogger();

// Middleware function for Express
export const requestLoggingMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  requestLogger.logRequest(req, res, next);
};

// Export the class for custom instances
export { RequestLogger };

import express, { Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { db } from '../db';

const router = express.Router();

// Middleware to check if debug routes are enabled
const checkDebugEnabled = (req: Request, res: Response, next: express.NextFunction): void => {
    const debugEnabled = process.env.ENABLE_DEBUG_ROUTES === 'true';
    
    if (!debugEnabled) {
        res.status(403).json({
            error: 'DEBUG_DISABLED',
            message: 'Debug routes are disabled',
            details: 'Set ENABLE_DEBUG_ROUTES=true to enable debug endpoints'
        });
        return;
    }
    
    next();
};

// Apply debug check to all routes
router.use(checkDebugEnabled);

/**
 * GET /api/debug/session
 * Returns current session data (sessionId, gameId, cookie info)
 */
router.get('/session', asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.sessionID;
    const gameId = (req.session as any).gameId;
    const cookie = req.session.cookie;
    
    // Get user info if authenticated
    const userId = req.user?.id;
    const username = req.user?.username;
    
    res.status(200).json({
        success: true,
        data: {
            sessionId,
            gameId: gameId || null,
            userId: userId || null,
            username: username || null,
            cookie: {
                originalMaxAge: cookie.originalMaxAge,
                expires: cookie.expires,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                sameSite: cookie.sameSite,
                path: cookie.path
            },
            sessionStore: process.env.NODE_ENV === 'production' ? 'PostgreSQL' : 'MemoryStore',
            nodeEnv: process.env.NODE_ENV,
            timestamp: new Date().toISOString()
        }
    });
}));

/**
 * GET /api/debug/session-table
 * Checks if session table exists and shows schema
 */
router.get('/session-table', asyncHandler(async (req: Request, res: Response) => {
    try {
        // Check if session table exists
        const tableExistsQuery = `
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'session'
            );
        `;
        const tableExistsResult = await db.query(tableExistsQuery);
        const tableExists = tableExistsResult.rows[0].exists;
        
        if (!tableExists) {
            return res.status(200).json({
                success: true,
                data: {
                    tableExists: false,
                    message: 'Session table does not exist in database',
                    recommendation: 'The session table should be created automatically by connect-pg-simple. Check server logs for initialization errors.'
                }
            });
        }
        
        // Get table schema
        const schemaQuery = `
            SELECT 
                column_name,
                data_type,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' 
            AND table_name = 'session'
            ORDER BY ordinal_position;
        `;
        const schemaResult = await db.query(schemaQuery);
        
        // Get table indexes
        const indexesQuery = `
            SELECT 
                indexname,
                indexdef
            FROM pg_indexes
            WHERE schemaname = 'public' 
            AND tablename = 'session';
        `;
        const indexesResult = await db.query(indexesQuery);
        
        // Count sessions
        const countQuery = 'SELECT COUNT(*) as count FROM session;';
        const countResult = await db.query(countQuery);
        
        res.status(200).json({
            success: true,
            data: {
                tableExists: true,
                schema: schemaResult.rows,
                indexes: indexesResult.rows,
                sessionCount: parseInt(countResult.rows[0].count, 10),
                expectedColumns: ['sid', 'sess', 'expire'],
                timestamp: new Date().toISOString()
            }
        });
    } catch (error: any) {
        console.error('Error checking session table:', error);
        res.status(500).json({
            error: 'DATABASE_ERROR',
            message: 'Failed to check session table',
            details: error.message || 'Unknown database error'
        });
    }
}));

/**
 * GET /api/debug/sessions
 * Lists all sessions in database (for debugging)
 * WARNING: This exposes session data - use with caution
 */
router.get('/sessions', asyncHandler(async (req: Request, res: Response) => {
    try {
        // Get all sessions with metadata
        const sessionsQuery = `
            SELECT 
                sid,
                expire,
                LENGTH(sess::text) as sess_size,
                sess->>'gameId' as game_id,
                sess->>'cookie' as cookie_data
            FROM session
            ORDER BY expire DESC
            LIMIT 100;
        `;
        const sessionsResult = await db.query(sessionsQuery);
        
        // Count total sessions
        const countQuery = 'SELECT COUNT(*) as count FROM session;';
        const countResult = await db.query(countQuery);
        
        // Count expired sessions
        const expiredQuery = `
            SELECT COUNT(*) as count 
            FROM session 
            WHERE expire < NOW();
        `;
        const expiredResult = await db.query(expiredQuery);
        
        res.status(200).json({
            success: true,
            data: {
                totalSessions: parseInt(countResult.rows[0].count, 10),
                expiredSessions: parseInt(expiredResult.rows[0].count, 10),
                activeSessions: parseInt(countResult.rows[0].count, 10) - parseInt(expiredResult.rows[0].count, 10),
                sessions: sessionsResult.rows.map(row => ({
                    sessionId: row.sid,
                    expiresAt: row.expire,
                    sessionSize: parseInt(row.sess_size, 10),
                    gameId: row.game_id || null,
                    hasCookie: !!row.cookie_data
                })),
                timestamp: new Date().toISOString(),
                warning: 'This endpoint exposes session metadata. Use with caution in production.'
            }
        });
    } catch (error: any) {
        console.error('Error listing sessions:', error);
        res.status(500).json({
            error: 'DATABASE_ERROR',
            message: 'Failed to list sessions',
            details: error.message || 'Unknown database error'
        });
    }
}));

/**
 * POST /api/debug/session/test
 * Creates a test session entry to verify write operations
 */
router.post('/session/test', asyncHandler(async (req: Request, res: Response) => {
    try {
        // Set a test value in the session
        const testValue = `test-${Date.now()}`;
        (req.session as any).testValue = testValue;
        (req.session as any).testTimestamp = new Date().toISOString();
        
        // Save the session
        await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
        
        // Verify the session was saved by checking the database
        const verifyQuery = `
            SELECT sess->>'testValue' as test_value, sess->>'testTimestamp' as test_timestamp
            FROM session
            WHERE sid = $1;
        `;
        const verifyResult = await db.query(verifyQuery, [req.sessionID]);
        
        if (verifyResult.rows.length === 0) {
            return res.status(500).json({
                error: 'SESSION_SAVE_FAILED',
                message: 'Session was not saved to database',
                details: 'The session save operation completed but the session was not found in the database'
            });
        }
        
        const savedTestValue = verifyResult.rows[0].test_value;
        const savedTimestamp = verifyResult.rows[0].test_timestamp;
        
        // Clean up test value
        delete (req.session as any).testValue;
        delete (req.session as any).testTimestamp;
        await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        res.status(200).json({
            success: true,
            data: {
                sessionId: req.sessionID,
                testValue: savedTestValue,
                testTimestamp: savedTimestamp,
                writeOperation: 'SUCCESS',
                readOperation: 'SUCCESS',
                message: 'Session write and read operations verified successfully'
            }
        });
    } catch (error: any) {
        console.error('Error testing session:', error);
        res.status(500).json({
            error: 'SESSION_TEST_FAILED',
            message: 'Session test failed',
            details: error.message || 'Unknown error during session test',
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}));

/**
 * GET /api/debug/session-store-info
 * Returns information about the session store configuration
 */
router.get('/session-store-info', asyncHandler(async (req: Request, res: Response) => {
    const storeType = process.env.NODE_ENV === 'production' ? 'PostgreSQL' : 'MemoryStore';
    const sessionSecretSet = !!process.env.SESSION_SECRET;
    const sessionSecretLength = process.env.SESSION_SECRET?.length || 0;
    
    res.status(200).json({
        success: true,
        data: {
            storeType,
            nodeEnv: process.env.NODE_ENV,
            sessionSecretConfigured: sessionSecretSet,
            sessionSecretLength: sessionSecretLength,
            cookieSecure: process.env.NODE_ENV === 'production',
            cookieHttpOnly: true,
            cookieMaxAge: 24 * 60 * 60 * 1000, // 24 hours
            databaseUrl: process.env.DATABASE_URL ? 'SET (hidden)' : 'NOT SET',
            databaseHost: process.env.DB_HOST || 'NOT SET',
            databaseName: process.env.DB_NAME || 'NOT SET',
            timestamp: new Date().toISOString()
        }
    });
}));

export default router;


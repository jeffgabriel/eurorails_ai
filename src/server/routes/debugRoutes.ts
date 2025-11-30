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
        
        // Check database permissions
        let hasCreateTablePermission = false;
        let permissionError: string | null = null;
        try {
            // Try to create a test table to check permissions
            await db.query('CREATE TABLE IF NOT EXISTS _test_permissions_check (id INTEGER)');
            await db.query('DROP TABLE IF EXISTS _test_permissions_check');
            hasCreateTablePermission = true;
        } catch (error: any) {
            permissionError = error.message || 'Unknown error';
            if (error.code === '42501') {
                permissionError = 'CREATE TABLE permission denied (error code 42501)';
            }
        }
        
        if (!tableExists) {
            return res.status(200).json({
                success: true,
                data: {
                    tableExists: false,
                    hasCreateTablePermission,
                    permissionError,
                    message: 'Session table does not exist in database',
                    recommendation: hasCreateTablePermission 
                        ? 'The session table should be created automatically by connect-pg-simple. You can manually create it using POST /api/debug/create-session-table'
                        : 'Database user lacks CREATE TABLE permissions. Grant CREATE privilege on the public schema or run the migration manually.',
                    sqlCommand: `CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`
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
        // Check what store is actually being used
        const storeType = (req.session as any).store?.constructor?.name || 'Unknown';
        const isPostgreSQL = storeType.includes('Pg') || storeType.includes('Postgres');
        
        // Set a test value in the session
        const testValue = `test-${Date.now()}`;
        (req.session as any).testValue = testValue;
        (req.session as any).testTimestamp = new Date().toISOString();
        
        // Save the session
        let saveError: any = null;
        await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
                if (err) {
                    saveError = err;
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
        
        if (saveError) {
            return res.status(500).json({
                error: 'SESSION_SAVE_ERROR',
                message: 'Session save failed',
                details: saveError.message || 'Unknown error during session save',
                storeType,
                isPostgreSQL
            });
        }
        
        // Wait a moment for async database write
        await new Promise(resolve => setTimeout(resolve, 100));
        
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
                details: 'The session save operation completed but the session was not found in the database',
                storeType,
                isPostgreSQL,
                sessionId: req.sessionID,
                recommendation: isPostgreSQL 
                    ? 'Session store appears to be PostgreSQL but sessions are not being written. Check session store initialization logs.'
                    : 'Session store is not PostgreSQL - sessions will not persist. Check NODE_ENV and session store configuration.'
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
                storeType,
                isPostgreSQL,
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
 * GET /api/debug/db-permissions
 * Check database permissions for the current user
 */
router.get('/db-permissions', asyncHandler(async (req: Request, res: Response) => {
    try {
        const permissions: Record<string, { granted: boolean; error?: string; code?: string }> = {};
        
        // Check CREATE TABLE permission
        try {
            await db.query('CREATE TABLE IF NOT EXISTS _test_create_table (id INTEGER)');
            await db.query('DROP TABLE IF EXISTS _test_create_table');
            permissions.createTable = { granted: true };
        } catch (error: any) {
            permissions.createTable = { 
                granted: false, 
                error: error.message || 'Unknown error',
                code: error.code
            };
        }
        
        // Check SELECT permission (should always work, but check anyway)
        try {
            await db.query('SELECT 1');
            permissions.select = { granted: true };
        } catch (error: any) {
            permissions.select = { 
                granted: false, 
                error: error.message || 'Unknown error',
                code: error.code
            };
        }
        
        // Check INSERT permission
        try {
            await db.query('CREATE TABLE IF NOT EXISTS _test_insert (id INTEGER)');
            await db.query('INSERT INTO _test_insert (id) VALUES (1)');
            await db.query('DROP TABLE IF EXISTS _test_insert');
            permissions.insert = { granted: true };
        } catch (error: any) {
            permissions.insert = { 
                granted: false, 
                error: error.message || 'Unknown error',
                code: error.code
            };
            // Clean up test table if it exists
            try {
                await db.query('DROP TABLE IF EXISTS _test_insert');
            } catch {}
        }
        
        // Get current database user
        const userQuery = await db.query('SELECT current_user, current_database()');
        const currentUser = userQuery.rows[0].current_user;
        const currentDatabase = userQuery.rows[0].current_database;
        
        res.status(200).json({
            success: true,
            data: {
                currentUser,
                currentDatabase,
                permissions,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error: any) {
        console.error('Error checking database permissions:', error);
        res.status(500).json({
            error: 'DATABASE_ERROR',
            message: 'Failed to check database permissions',
            details: error.message || 'Unknown database error'
        });
    }
}));

/**
 * POST /api/debug/create-session-table
 * Manually create the session table
 */
router.post('/create-session-table', asyncHandler(async (req: Request, res: Response) => {
    try {
        // Check if table already exists
        const tableCheck = await db.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'session'
            );
        `);
        const tableExists = tableCheck.rows[0].exists;
        
        if (tableExists) {
            return res.status(200).json({
                success: true,
                data: {
                    message: 'Session table already exists',
                    tableExists: true
                }
            });
        }
        
        // Create the table
        await db.query(`
            CREATE TABLE IF NOT EXISTS "session" (
              "sid" varchar NOT NULL COLLATE "default",
              "sess" json NOT NULL,
              "expire" timestamp(6) NOT NULL
            )
            WITH (OIDS=FALSE);
        `);
        
        // Add primary key
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
        
        // Create index
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
            res.status(200).json({
                success: true,
                data: {
                    message: 'Session table created successfully',
                    tableExists: true,
                    timestamp: new Date().toISOString()
                }
            });
        } else {
            res.status(500).json({
                error: 'TABLE_CREATION_FAILED',
                message: 'Table creation command completed but table was not found',
                details: 'This may indicate a permissions issue or database connection problem'
            });
        }
    } catch (error: any) {
        console.error('Error creating session table:', error);
        res.status(500).json({
            error: 'TABLE_CREATION_ERROR',
            message: 'Failed to create session table',
            details: error.message || 'Unknown error during table creation',
            code: error.code || 'unknown',
            hint: error.code === '42501' 
                ? 'Database user lacks CREATE TABLE permissions. Grant CREATE privilege on the public schema.'
                : undefined
        });
    }
}));

/**
 * GET /api/debug/session-store-info
 * Returns information about the session store configuration
 */
router.get('/session-store-info', asyncHandler(async (req: Request, res: Response) => {
    // Get the actual session store instance from the request
    // The store might be on req.session.store or req.sessionStore
    const actualStore = (req.session as any).store || (req as any).sessionStore;
    const storeType = actualStore ? (actualStore.constructor?.name || 'Unknown') : 'MemoryStore';
    // PGStore, PgStore, and PostgresStore are all PostgreSQL stores
    // Also check NODE_ENV as a fallback indicator
    const isPostgreSQL = storeType.includes('Pg') || storeType.includes('Postgres') || storeType === 'PGStore' || 
                         (process.env.NODE_ENV === 'production' && storeType !== 'MemoryStore');
    
    // Check if session is actually being saved to database
    let sessionInDatabase = false;
    let databaseCheckError: string | null = null;
    try {
        const checkQuery = await db.query('SELECT sid FROM session WHERE sid = $1 LIMIT 1', [req.sessionID]);
        sessionInDatabase = checkQuery.rows.length > 0;
    } catch (error: any) {
        databaseCheckError = error.message || 'Unknown error';
    }
    
    const sessionSecretSet = !!process.env.SESSION_SECRET;
    const sessionSecretLength = process.env.SESSION_SECRET?.length || 0;
    
    // Get database connection info
    const dbConfig = {
        databaseUrl: process.env.DATABASE_URL ? 'SET (hidden)' : 'NOT SET',
        databaseHost: process.env.DB_HOST || 'NOT SET',
        databaseName: process.env.DB_NAME || 'NOT SET',
        databaseUser: process.env.DB_USER || 'NOT SET',
    };
    
    res.status(200).json({
        success: true,
        data: {
            storeType,
            isPostgreSQL,
            actualStoreType: actualStore ? actualStore.constructor?.name : 'No store (MemoryStore)',
            sessionInDatabase,
            databaseCheckError,
            nodeEnv: process.env.NODE_ENV,
            sessionSecretConfigured: sessionSecretSet,
            sessionSecretLength: sessionSecretLength,
            cookieSecure: process.env.NODE_ENV === 'production',
            cookieHttpOnly: true,
            cookieMaxAge: 24 * 60 * 60 * 1000, // 24 hours
            ...dbConfig,
            currentSessionId: req.sessionID,
            timestamp: new Date().toISOString(),
            warning: !isPostgreSQL ? 'Session store is NOT using PostgreSQL - sessions will not persist!' : undefined
        }
    });
}));

export default router;


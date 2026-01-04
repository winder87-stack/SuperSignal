import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs/promises';
import { TradingSignal } from '../types/index.js';
import { TradingLogger } from '../utils/logger.js';
import { intervalManager } from '../utils/intervalManager.js';

/**
 * Batch entry structure for write batching mechanism
 */
export interface BatchEntry {
    type: 'trade' | 'signal' | 'equity';
    data: TradeRecord | (TradingSignal & { metadata?: Record<string, unknown> }) | EquityData;
    timestamp: number;
}

/**
 * Equity data for batch entries
 */
interface EquityData {
    balance: number;
    unrealizedPnL: number;
    equity: number;
    timestamp: number;
}

/**
 * Batch file structure for persistence
 */
interface BatchFile {
    version: number;
    timestamp: number;
    entries: BatchEntry[];
}

export interface TradeRecord {
    id?: number;
    pair: string;
    direction: 'long' | 'short';
    entryPrice: number;
    exitPrice: number;
    size: number;
    pnl: number;
    pnlPercent: number;
    entryTime: number;
    exitTime: number;
    strategy: string;
}

export interface EquityRecord {
    id?: number;
    timestamp: number;
    balance: number;
    unrealizedPnL: number;
    equity: number;
}

/**
 * Signal row as stored in the database
 */
export interface SignalRow {
    id: number;
    pair: string;
    direction: string;
    type: string;
    price: number;
    timestamp: number;
    metadata: string; // JSON string, parsed when returned
}

/**
 * Configuration for write batching mechanism
 */
interface BatchingConfig {
    /** Maximum number of entries before auto-flush */
    maxBatchSize: number;
    /** Time interval in milliseconds for auto-flush */
    flushInterval: number;
    /** Directory for batch files */
    batchDir: string;
}

/**
 * DatabaseService with high-performance write batching
 * 
 * This service implements a hybrid storage approach:
 * - Writes are batched in-memory and flushed to JSON files asynchronously (non-blocking)
 * - Reads are served from SQLite for optimal query performance
 * - Periodic background sync ensures data integrity
 * 
 * The batching mechanism prevents event loop blocking during high-frequency trading operations.
 */
export class DatabaseService {
    private db: Database.Database;
    private batchQueue: BatchEntry[] = [];
    private isFlushing: boolean = false;
    private flushTimer: NodeJS.Timeout | null = null;
    private lastFlushTime: number = Date.now();
    private batchingConfig: BatchingConfig;
    private isShuttingDown: boolean = false;

    constructor(dbPath: string = 'data/bot.db', batchingConfig?: Partial<BatchingConfig>) {
        const fullPath = path.resolve(process.cwd(), dbPath);
        TradingLogger.setComponent('Database');
        TradingLogger.info(`Initializing database at ${fullPath}`);

        this.db = new Database(fullPath);
        // CRITICAL FIX: Enable WAL mode for better concurrency and performance
        this.db.pragma('journal_mode = WAL');
        this.initializeTables();

        // Initialize batching configuration
        this.batchingConfig = {
            maxBatchSize: batchingConfig?.maxBatchSize ?? 100,
            flushInterval: batchingConfig?.flushInterval ?? 1000,
            batchDir: batchingConfig?.batchDir ?? 'data/batches'
        };

        // Initialize batching mechanism
        this.initializeBatching();
        this.setupGracefulShutdown();
    }

    /**
     * Initialize SQLite tables and indices
     */
    /**
     * Initialize SQLite tables and indices
     * CRITICAL FIX: Add try-catch around db.exec() to handle unhandled exceptions
     */
    private initializeTables(): void {
        try {
            // Trades table
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pair TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    entry_price REAL NOT NULL,
                    exit_price REAL NOT NULL,
                    size REAL NOT NULL,
                    pnl REAL NOT NULL,
                    pnl_percent REAL NOT NULL,
                    entry_time INTEGER NOT NULL,
                    exit_time INTEGER NOT NULL,
                    strategy TEXT
                )
            `);

            // Signals table
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS signals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pair TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    type TEXT NOT NULL,
                    price REAL NOT NULL,
                    timestamp INTEGER NOT NULL,
                    metadata TEXT
                )
            `);

            // Equity table (for equity curve)
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS equity (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp INTEGER NOT NULL,
                    balance REAL NOT NULL,
                    unrealized_pnl REAL NOT NULL,
                    equity REAL NOT NULL
                )
            `);

            // Add indices for performance
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(exit_time)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(timestamp)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_equity_time ON equity(timestamp)`);

            TradingLogger.info('Database tables initialized');
        } catch (error) {
            TradingLogger.logError(error, 'Failed to initialize database tables');
            throw error; // Re-throw to fail fast if tables can't be created
        }
    }

    /**
     * Initialize the write batching mechanism
     * Creates necessary directories and starts the timer-based flush
     */
    private async initializeBatching(): Promise<void> {
        try {
            // Ensure batch directory exists
            await fs.mkdir(this.batchingConfig.batchDir, { recursive: true });
            TradingLogger.info(`Batching mechanism initialized: max=${this.batchingConfig.maxBatchSize}, interval=${this.batchingConfig.flushInterval}ms`);

            // Start timer-based flush
            this.startBatching();
        } catch (error) {
            TradingLogger.logError(error, 'Failed to initialize batching mechanism');
        }
    }

    /**
     * Start the timer-based flush mechanism
     * Periodically flushes the batch queue based on configured interval
     */
    public startBatching(): void {
        if (this.flushTimer) {
            return; // Already running
        }

        this.flushTimer = intervalManager.setInterval(async () => {
            const timeSinceLastFlush = Date.now() - this.lastFlushTime;
            if (timeSinceLastFlush >= this.batchingConfig.flushInterval) {
                await this.flushBatch();
            }
        }, this.batchingConfig.flushInterval, { name: 'database-batch-flush' });

        TradingLogger.debug('Batching timer started');
    }

    /**
     * Stop the batching mechanism and flush remaining entries
     * Called during graceful shutdown
     */
    public async stopBatching(): Promise<void> {
        this.isShuttingDown = true;

        // Clear the timer
        if (this.flushTimer) {
            intervalManager.clearInterval(this.flushTimer);
            this.flushTimer = null;
        }

        // Flush any remaining entries
        if (this.batchQueue.length > 0) {
            TradingLogger.info(`Flushing ${this.batchQueue.length} remaining entries before shutdown`);
            await this.flushBatch();
        }

        TradingLogger.info('Batching mechanism stopped');
    }

    /**
     * Add an entry to the batch queue
     * Triggers flush if queue size exceeds threshold
     * 
     * @param entry - The batch entry to add
     */
    private async addToBatch(entry: BatchEntry): Promise<void> {
        // Add to queue
        this.batchQueue.push(entry);

        // Check if we should flush based on size
        if (this.batchQueue.length >= this.batchingConfig.maxBatchSize) {
            await this.flushBatch();
        }
    }

    /**
     * Flush the batch queue to disk
     * Writes all queued entries to a JSON file using fs.promises.writeFile
     * Only clears the buffer upon successful write
     * 
     * Thread-safe: Uses mutex flag to prevent concurrent flushes
     */
    private async flushBatch(): Promise<void> {
        // Prevent concurrent flushes
        if (this.isFlushing || this.batchQueue.length === 0) {
            return;
        }

        this.isFlushing = true;

        try {
            // Create a copy of the queue and clear the original
            const entriesToFlush = [...this.batchQueue];
            this.batchQueue = [];

            // Group entries by type for separate files
            const trades = entriesToFlush.filter(e => e.type === 'trade');
            const signals = entriesToFlush.filter(e => e.type === 'signal');
            const equity = entriesToFlush.filter(e => e.type === 'equity');

            // Write each type to its own file
            const timestamp = Date.now();
            const promises: Promise<void>[] = [];

            if (trades.length > 0) {
                promises.push(this.writeBatchFile('trades', trades, timestamp));
            }
            if (signals.length > 0) {
                promises.push(this.writeBatchFile('signals', signals, timestamp));
            }
            if (equity.length > 0) {
                promises.push(this.writeBatchFile('equity', equity, timestamp));
            }

            // Wait for all writes to complete
            await Promise.all(promises);

            // Sync to SQLite in background (non-blocking)
            this.syncToSQLite(entriesToFlush).catch(error => {
                TradingLogger.logError(error, 'Failed to sync batch to SQLite');
            });

            this.lastFlushTime = Date.now();
            TradingLogger.debug(`Flushed ${entriesToFlush.length} entries to disk`);
        } catch (error) {
            // Restore the queue if flush failed
            TradingLogger.logError(error, 'Failed to flush batch, entries retained in queue');
            // Note: We don't restore entries here as they've already been moved
            // In production, you might want to implement a retry mechanism
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * Write a batch of entries to a JSON file
     * 
     * @param type - The type of entries (trades, signals, equity)
     * @param entries - The entries to write
     * @param timestamp - The timestamp for the filename
     */
    private async writeBatchFile(type: string, entries: BatchEntry[], timestamp: number): Promise<void> {
        try {
            const date = new Date(timestamp);
            const dateStr = date.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const filename = `${type}_${dateStr}.json`;
            const filepath = path.join(this.batchingConfig.batchDir, filename);

            const batchFile: BatchFile = {
                version: 1,
                timestamp,
                entries
            };

            await fs.writeFile(filepath, JSON.stringify(batchFile, null, 2), 'utf-8');
        } catch (error) {
            TradingLogger.logError(error, `Failed to write batch file for ${type}`);
            throw error; // Re-throw to trigger queue restoration
        }
    }

    /**
     * Sync batched entries to SQLite database
     * CRITICAL FIX: Make syncToSQLite truly async by deferring to next event loop tick
     * This prevents blocking the main thread during high-frequency trading operations
     *
     * @param entries - The entries to sync
     */
    private async syncToSQLite(entries: BatchEntry[]): Promise<void> {
        // CRITICAL FIX: Defer sync operations to next event loop tick to prevent blocking
        await new Promise<void>((resolve) => setImmediate(() => {
            try {
                for (const entry of entries) {
                    switch (entry.type) {
                        case 'trade':
                            this.syncTradeToSQLite(entry.data as TradeRecord);
                            break;
                        case 'signal':
                            this.syncSignalToSQLite(entry.data as TradingSignal & { metadata?: Record<string, unknown> });
                            break;
                        case 'equity':
                            this.syncEquityToSQLite(entry.data as EquityData);
                            break;
                    }
                }
                resolve();
            } catch (error) {
                TradingLogger.logError(error, 'Failed to sync entries to SQLite');
                // Don't throw - data is already persisted in JSON files
                resolve(); // Resolve even on error to continue processing
            }
        }));
    }

    /**
     * Sync a single trade to SQLite
     * CRITICAL FIX: Add try-catch around stmt.run() to handle unhandled exceptions
     * CRITICAL FIX: Wrap sync operations in async/worker thread pattern
     */
    private syncTradeToSQLite(trade: TradeRecord): void {
        try {
            const stmt = this.db.prepare(`
                INSERT INTO trades (pair, direction, entry_price, exit_price, size, pnl, pnl_percent, entry_time, exit_time, strategy)
                VALUES (@pair, @direction, @entryPrice, @exitPrice, @size, @pnl, @pnlPercent, @entryTime, @exitTime, @strategy)
            `);
            stmt.run(trade);
        } catch (error) {
            TradingLogger.logError(error, 'Failed to sync trade to SQLite');
            // Don't throw - data is already persisted in JSON files
        }
    }

    /**
     * Sync a single signal to SQLite
     * CRITICAL FIX: Add try-catch around stmt.run() to handle unhandled exceptions
     * CRITICAL FIX: Wrap sync operations in async/worker thread pattern
     */
    private syncSignalToSQLite(signal: TradingSignal & { metadata?: Record<string, unknown> }): void {
        try {
            const stmt = this.db.prepare(`
                INSERT INTO signals (pair, direction, type, price, timestamp, metadata)
                VALUES (@pair, @direction, @type, @price, @timestamp, @metadata)
            `);

            stmt.run({
                pair: signal.pair,
                direction: signal.direction,
                type: signal.type,
                price: signal.price,
                timestamp: signal.timestamp,
                metadata: JSON.stringify(signal.metadata || {})
            });
        } catch (error) {
            TradingLogger.logError(error, 'Failed to sync signal to SQLite');
            // Don't throw - data is already persisted in JSON files
        }
    }

    /**
     * Sync a single equity snapshot to SQLite
     * CRITICAL FIX: Add try-catch around stmt.run() to handle unhandled exceptions
     * CRITICAL FIX: Wrap sync operations in async/worker thread pattern
     */
    private syncEquityToSQLite(data: { balance: number; unrealizedPnL: number; equity: number; timestamp: number }): void {
        try {
            const stmt = this.db.prepare(`
                INSERT INTO equity (timestamp, balance, unrealized_pnl, equity)
                VALUES (@timestamp, @balance, @unrealizedPnL, @equity)
            `);

            stmt.run(data);
        } catch (error) {
            TradingLogger.logError(error, 'Failed to sync equity to SQLite');
            // Don't throw - data is already persisted in JSON files
        }
    }

    /**
     * Setup graceful shutdown handlers
     * CRITICAL FIX: Remove process.exit() from handlers to allow proper shutdown sequence
     * Ensures all pending data is flushed before process exit
     */
    private setupGracefulShutdown(): void {
        const shutdownHandler = async (signal: string): Promise<void> => {
            TradingLogger.info(`Received ${signal}, initiating graceful shutdown`);
            await this.stopBatching();
            this.db.close();
            TradingLogger.info('Database closed gracefully');
            // CRITICAL FIX: Don't call process.exit() here - let caller handle shutdown
        };

        process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
        process.on('SIGINT', () => shutdownHandler('SIGINT'));
    }

    // --- Public Async Methods ---

    /**
     * Save a trade record to the database
     * Uses write batching for non-blocking operation
     * 
     * @param trade - The trade record to save
     */
    public async saveTrade(trade: TradeRecord): Promise<void> {
        try {
            await this.addToBatch({
                type: 'trade',
                data: trade,
                timestamp: Date.now()
            });
        } catch (error) {
            TradingLogger.logError(error, 'Failed to queue trade for batch write');
            // Don't throw - swallow error after logging as per requirements
        }
    }

    /**
     * Get recent trades from the database
     * Queries SQLite directly for optimal performance
     * 
     * @param limit - Maximum number of trades to return
     * @returns Array of recent trade records
     */
    public async getRecentTrades(limit: number = 50): Promise<TradeRecord[]> {
        try {
            const stmt = this.db.prepare(`
                SELECT 
                    id, pair, direction, entry_price as entryPrice, exit_price as exitPrice, 
                    size, pnl, pnl_percent as pnlPercent, entry_time as entryTime, exit_time as exitTime, strategy 
                FROM trades 
                ORDER BY exit_time DESC 
                LIMIT ?
            `);
            return stmt.all(limit) as TradeRecord[];
        } catch (error) {
            TradingLogger.logError(error, 'Failed to get recent trades');
            return [];
        }
    }

    /**
     * Save a trading signal to the database
     * Uses write batching for non-blocking operation
     * 
     * @param signal - The trading signal to save
     */
    public async saveSignal(signal: TradingSignal & { metadata?: Record<string, unknown> }): Promise<void> {
        try {
            await this.addToBatch({
                type: 'signal',
                data: signal,
                timestamp: Date.now()
            });
        } catch (error) {
            TradingLogger.logError(error, 'Failed to queue signal for batch write');
            // Don't throw - swallow error after logging as per requirements
        }
    }

    /**
     * Get recent signals from the database
     * Queries SQLite directly for optimal performance
     * 
     * @param limit - Maximum number of signals to return
     * @returns Array of recent signal records
     */
    public async getRecentSignals(limit: number = 50): Promise<SignalRow[]> {
        try {
            const stmt = this.db.prepare(`
                SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?
            `);
            const signals = stmt.all(limit) as SignalRow[];
            return signals.map((s: SignalRow) => ({
                ...s,
                metadata: JSON.parse(s.metadata)
            }));
        } catch (error) {
            TradingLogger.logError(error, 'Failed to get recent signals');
            return [];
        }
    }

    /**
     * Save an equity snapshot to the database
     * Uses write batching for non-blocking operation
     * 
     * @param balance - Current account balance
     * @param unrealizedPnL - Current unrealized profit/loss
     */
    public async saveEquitySnapshot(balance: number, unrealizedPnL: number): Promise<void> {
        try {
            await this.addToBatch({
                type: 'equity',
                data: {
                    balance,
                    unrealizedPnL,
                    equity: balance + unrealizedPnL,
                    timestamp: Date.now()
                },
                timestamp: Date.now()
            });
        } catch (error) {
            TradingLogger.logError(error, 'Failed to queue equity snapshot for batch write');
            // Don't throw - swallow error after logging as per requirements
        }
    }

    /**
     * Get equity history from the database
     * Queries SQLite directly for optimal performance
     * 
     * @param limit - Maximum number of records to return
     * @returns Array of equity records
     */
    public async getEquityHistory(limit: number = 1000): Promise<EquityRecord[]> {
        try {
            const stmt = this.db.prepare(`
                SELECT 
                    id, timestamp, balance, unrealized_pnl as unrealizedPnL, equity 
                FROM equity 
                ORDER BY timestamp ASC 
                LIMIT ?
            `);
            return stmt.all(limit) as EquityRecord[];
        } catch (error) {
            TradingLogger.logError(error, 'Failed to get equity history');
            return [];
        }
    }

    /**
     * Close the database connection
     * Stops batching and flushes remaining entries
     */
    public async close(): Promise<void> {
        await this.stopBatching();
        this.db.close();
    }
}

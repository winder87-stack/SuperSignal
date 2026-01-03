import Database from 'better-sqlite3';
import path from 'path';
import { TradingSignal } from '../types/index.js';
import { TradingLogger } from '../utils/logger.js';

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

export class DatabaseService {
    private db: Database.Database;

    constructor(dbPath: string = 'data/bot.db') {
        const fullPath = path.resolve(process.cwd(), dbPath);
        TradingLogger.info(`Initializing database at ${fullPath}`);

        this.db = new Database(fullPath);
        this.initializeTables();
    }

    private initializeTables() {
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
    }

    // --- Trades ---

    public saveTrade(trade: TradeRecord): void {
        const stmt = this.db.prepare(`
            INSERT INTO trades (pair, direction, entry_price, exit_price, size, pnl, pnl_percent, entry_time, exit_time, strategy)
            VALUES (@pair, @direction, @entryPrice, @exitPrice, @size, @pnl, @pnlPercent, @entryTime, @exitTime, @strategy)
        `);
        stmt.run(trade);
    }

    public getRecentTrades(limit: number = 50): TradeRecord[] {
        const stmt = this.db.prepare(`
            SELECT 
                id, pair, direction, entry_price as entryPrice, exit_price as exitPrice, 
                size, pnl, pnl_percent as pnlPercent, entry_time as entryTime, exit_time as exitTime, strategy 
            FROM trades 
            ORDER BY exit_time DESC 
            LIMIT ?
        `);
        return stmt.all(limit) as TradeRecord[];
    }

    // --- Signals ---

    public saveSignal(signal: TradingSignal & { metadata?: any }): void {
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
    }

    public getRecentSignals(limit: number = 50): any[] {
        const stmt = this.db.prepare(`
            SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?
        `);
        const signals = stmt.all(limit);
        return signals.map((s: any) => ({
            ...s,
            metadata: JSON.parse(s.metadata)
        }));
    }

    // --- Equity ---

    public saveEquitySnapshot(balance: number, unrealizedPnL: number): void {
        const stmt = this.db.prepare(`
            INSERT INTO equity (timestamp, balance, unrealized_pnl, equity)
            VALUES (@timestamp, @balance, @unrealizedPnL, @equity)
        `);

        stmt.run({
            timestamp: Date.now(),
            balance,
            unrealizedPnL,
            equity: balance + unrealizedPnL
        });
    }

    public getEquityHistory(limit: number = 1000): EquityRecord[] {
        const stmt = this.db.prepare(`
            SELECT 
                id, timestamp, balance, unrealized_pnl as unrealizedPnL, equity 
            FROM equity 
            ORDER BY timestamp ASC 
            LIMIT ?
        `);
        return stmt.all(limit) as EquityRecord[];
    }

    public close(): void {
        this.db.close();
    }
}

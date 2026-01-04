// Dry-Run Paper Trading Manager
// Simulates trades on mainnet data without executing real orders

import { EventEmitter } from 'events';
import { Decimal } from 'decimal.js';
import { TradingLogger } from '../utils/logger.js';
import { intervalManager } from '../utils/intervalManager.js';
import { FinancialMath } from '../utils/math.js';
import { TradingPair, TradingSignal, RiskConfig } from '../types/index.js';
import { promises as fs } from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface DryRunConfig {
    initialBalance: Decimal;
    slippagePercent: Decimal; // 0.05% = 0.0005
    dataPath: string;
    riskConfig: RiskConfig;
}

export interface DryRunTrade {
    id: string;
    timestamp: number;
    pair: TradingPair;
    direction: 'long' | 'short';
    entryPrice: number;
    exitPrice?: number;
    size: number; // In asset units
    sizeUsd: number; // In USD
    stopLoss: number;
    takeProfit?: number;
    pnl?: number;
    pnlPercent?: number;
    exitReason?: 'TP' | 'SL' | 'TRAILING_STOP' | 'STRATEGY_EXIT' | 'PARTIAL';
    exitTime?: number;
}

export interface DryRunStats {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    largestWin: number;
    largestLoss: number;
    nearMisses: number; // 3/4 stochastics aligned but entry skipped
}

export interface DailySummary {
    date: string; // YYYY-MM-DD
    trades: number;
    wins: number;
    losses: number;
    dayPnl: number;
    runningBalance: number;
}

export interface DryRunState {
    startTime: string;
    initialBalance: number;
    currentBalance: number;
    trades: DryRunTrade[];
    stats: DryRunStats;
    dailySummaries: DailySummary[];
}

// ============================================================================
// DryRunManager Class
// ============================================================================

export class DryRunManager extends EventEmitter {
    private config: DryRunConfig;
    private balance: Decimal;
    private positions: Map<TradingPair, DryRunTrade> = new Map();
    private tradeHistory: DryRunTrade[] = [];
    private stats: DryRunStats;
    private dailySummaries: DailySummary[] = [];
    private startTime: Date;
    private nearMissCount: number = 0;
    private tradesToday: { wins: number; losses: number } = { wins: 0, losses: 0 };
    private lastDayReset: string;

    private hourlyInterval?: NodeJS.Timeout;
    private dailyInterval?: NodeJS.Timeout;

    constructor(config: DryRunConfig) {
        super();
        this.config = config;
        this.balance = config.initialBalance;
        this.startTime = new Date();
        this.lastDayReset = this.getDateString();

        this.stats = {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            totalPnl: 0,
            largestWin: 0,
            largestLoss: 0,
            nearMisses: 0
        };

        // Note: State loading is now done via async initialize() method
        TradingLogger.info(
            `[DRY-RUN] Paper trading mode initialized with $${this.balance.toFixed(2)} virtual balance`
        );
    }

    /**
     * Initialize the manager by loading previous state asynchronously
     * Call this after construction to restore previous state
     */
    public async initialize(): Promise<void> {
        await this.loadState();
    }

    // ============================================================================
    // Trade Execution (Simulated)
    // ============================================================================

    /**
     * Execute a simulated entry trade
     */
    public async executeEntry(
        signal: TradingSignal,
        sizeUsd: Decimal,
        stopLoss: Decimal,
        takeProfit?: Decimal
    ): Promise<boolean> {
        // Check max concurrent positions
        const maxPositions = this.config.riskConfig.maxConcurrentPositions ?? Infinity;
        if (this.positions.size >= maxPositions) {
            TradingLogger.warn(
                `[DRY-RUN] Entry rejected: max concurrent positions (${maxPositions}) reached`
            );
            return false;
        }

        // Check if we already have a position for this pair
        if (this.positions.has(signal.pair)) {
            TradingLogger.warn(`[DRY-RUN] Entry rejected: position already exists for ${signal.pair}`);
            return false;
        }

        // Apply slippage: buy higher, sell lower
        const slippage = signal.price.mul(this.config.slippagePercent);
        const executionPrice = signal.direction === 'long'
            ? signal.price.add(slippage)
            : signal.price.sub(slippage);

        // Calculate size in asset units
        const size = sizeUsd.div(executionPrice);

        // Create trade record
        const trade: DryRunTrade = {
            id: `dry-${Date.now()}-${signal.pair}`,
            timestamp: Date.now(),
            pair: signal.pair,
            direction: signal.direction as 'long' | 'short',
            entryPrice: executionPrice.toNumber(),
            size: size.toNumber(),
            sizeUsd: sizeUsd.toNumber(),
            stopLoss: stopLoss.toNumber(),
            takeProfit: takeProfit?.toNumber()
        };

        // Store position
        this.positions.set(signal.pair, trade);

        TradingLogger.info(
            `[DRY-RUN] Entry: ${signal.pair} ${signal.direction.toUpperCase()} @ ${executionPrice.toFixed(4)} | ` +
            `Size: $${sizeUsd.toFixed(2)} (${size.toFixed(6)} units) | SL: ${stopLoss.toFixed(4)}` +
            (takeProfit ? ` | TP: ${takeProfit.toFixed(4)}` : '')
        );

        await this.persist();
        return true;
    }

    /**
     * Execute a simulated exit trade
     */
    public async executeExit(
        pair: TradingPair,
        exitPrice: Decimal,
        reason: 'TP' | 'SL' | 'TRAILING_STOP' | 'STRATEGY_EXIT'
    ): Promise<Decimal | null> {
        const trade = this.positions.get(pair);
        if (!trade) {
            TradingLogger.warn(`[DRY-RUN] Exit rejected: no position for ${pair}`);
            return null;
        }

        // Apply slippage: selling gets lower price, buying (to close short) gets higher
        const slippage = exitPrice.mul(this.config.slippagePercent);
        const executionPrice = trade.direction === 'long'
            ? exitPrice.sub(slippage) // Selling
            : exitPrice.add(slippage); // Buying to close

        // Calculate P&L
        const pnl = FinancialMath.calculatePnL(
            new Decimal(trade.entryPrice),
            executionPrice,
            new Decimal(trade.size),
            trade.direction
        );

        const pnlPercent = pnl.div(new Decimal(trade.sizeUsd)).mul(100).toNumber();

        // Update trade record
        trade.exitPrice = executionPrice.toNumber();
        trade.exitTime = Date.now();
        trade.exitReason = reason;
        trade.pnl = pnl.toNumber();
        trade.pnlPercent = pnlPercent;

        // Update balance
        this.balance = this.balance.add(pnl);

        // Update stats
        this.updateStats(pnl);

        // Move to history
        this.tradeHistory.push(trade);
        this.positions.delete(pair);

        TradingLogger.info(
            `[DRY-RUN] Exit: ${pair} ${trade.direction.toUpperCase()} @ ${executionPrice.toFixed(4)} | ` +
            `Reason: ${reason} | P&L: ${pnl.gte(0) ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%) | ` +
            `Balance: $${this.balance.toFixed(2)}`
        );

        await this.persist();

        this.emit('trade_closed', {
            pair,
            pnl: pnl.toNumber(),
            balance: this.balance.toNumber(),
            reason
        });

        return pnl;
    }

    /**
     * Execute a partial exit (50% scale-out)
     */
    public async executePartialExit(pair: TradingPair, exitPrice: Decimal): Promise<Decimal | null> {
        const trade = this.positions.get(pair);
        if (!trade) {
            TradingLogger.warn(`[DRY-RUN] Partial exit rejected: no position for ${pair}`);
            return null;
        }

        const partialSize = new Decimal(trade.size).div(2);
        const partialSizeUsd = new Decimal(trade.sizeUsd).div(2);

        // Apply slippage
        const slippage = exitPrice.mul(this.config.slippagePercent);
        const executionPrice = trade.direction === 'long'
            ? exitPrice.sub(slippage)
            : exitPrice.add(slippage);

        // Calculate partial P&L
        const pnl = FinancialMath.calculatePnL(
            new Decimal(trade.entryPrice),
            executionPrice,
            partialSize,
            trade.direction
        );

        // Update balance
        this.balance = this.balance.add(pnl);

        // Update trade size
        trade.size = partialSize.toNumber();
        trade.sizeUsd = partialSizeUsd.toNumber();

        TradingLogger.info(
            `[DRY-RUN] Partial Exit: ${pair} 50% closed @ ${executionPrice.toFixed(4)} | ` +
            `P&L: ${pnl.gte(0) ? '+' : ''}$${pnl.toFixed(2)} | Remaining: $${partialSizeUsd.toFixed(2)} | ` +
            `Balance: $${this.balance.toFixed(2)}`
        );

        await this.persist();
        return pnl;
    }

    /**
     * Update trailing stop (simulation - just logs)
     */
    public updateTrailingStop(pair: TradingPair, newStop: Decimal, reason: string): void {
        const trade = this.positions.get(pair);
        if (!trade) return;

        const oldStop = trade.stopLoss;
        trade.stopLoss = newStop.toNumber();

        TradingLogger.info(
            `[DRY-RUN] Trailing Stop Updated [${reason}]: ${pair} | ${oldStop.toFixed(4)} -> ${newStop.toFixed(4)}`
        );
    }

    // ============================================================================
    // Statistics & Tracking
    // ============================================================================

    private updateStats(pnl: Decimal): void {
        this.stats.totalTrades++;
        this.stats.totalPnl = new Decimal(this.stats.totalPnl).add(pnl).toNumber();

        if (pnl.gte(0)) {
            this.stats.wins++;
            this.tradesToday.wins++;
            if (pnl.toNumber() > this.stats.largestWin) {
                this.stats.largestWin = pnl.toNumber();
            }
        } else {
            this.stats.losses++;
            this.tradesToday.losses++;
            if (pnl.toNumber() < this.stats.largestLoss) {
                this.stats.largestLoss = pnl.toNumber();
            }
        }

        this.stats.winRate = this.stats.totalTrades > 0
            ? this.stats.wins / this.stats.totalTrades
            : 0;
    }

    /**
     * Increment near-miss counter (called from strategy when 3/4 stochastics align)
     */
    public recordNearMiss(): void {
        this.nearMissCount++;
        this.stats.nearMisses++;
    }

    // ============================================================================
    // Logging & Reporting
    // ============================================================================

    /**
     * Start hourly and daily reporting intervals
     */
    public startReporting(): void {
        // Hourly status log
        this.hourlyInterval = intervalManager.setInterval(() => {
            this.logHourlyStatus();
        }, 60 * 60 * 1000, { name: 'dryrun-hourly-status' }); // Every hour

        // Daily summary at 00:00 UTC
        this.scheduleDailySummary();

        TradingLogger.info('[DRY-RUN] Reporting intervals started (hourly status, daily summary at 00:00 UTC)');
    }

    private scheduleDailySummary(): void {
        const msUntilMidnight = this.getMsUntilMidnightUTC();

        // CRITICAL FIX: Replace native setTimeout with intervalManager for proper cleanup
        // Schedule first run at next midnight UTC using a one-shot interval
        this.dailyInterval = intervalManager.setInterval(() => {
            this.logDailySummary();

            // Clear this interval and set up recurring one
            if (this.dailyInterval) {
                intervalManager.clearInterval(this.dailyInterval);
            }

            // Then run every 24 hours
            this.dailyInterval = intervalManager.setInterval(() => {
                this.logDailySummary();
            }, 24 * 60 * 60 * 1000, { name: 'dryrun-daily-summary' });
        }, msUntilMidnight, { name: 'dryrun-daily-summary-initial' });
    }

    private getMsUntilMidnightUTC(): number {
        const now = new Date();
        const tomorrow = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0, 0, 0, 0
        ));
        return tomorrow.getTime() - now.getTime();
    }

    public logHourlyStatus(): void {
        const pnlTotal = this.balance.sub(this.config.initialBalance);
        const pnlPercent = pnlTotal.div(this.config.initialBalance).mul(100);

        let openPosStr = 'None';
        if (this.positions.size > 0) {
            const pos = Array.from(this.positions.values())[0];
            openPosStr = `${pos.pair} ${pos.direction} @ ${pos.entryPrice.toFixed(4)} | Size: $${pos.sizeUsd.toFixed(2)} | Stop: ${pos.stopLoss.toFixed(4)}`;
        }

        const tradesTodayCount = this.tradesToday.wins + this.tradesToday.losses;
        const winRate = this.stats.totalTrades > 0 ? (this.stats.winRate * 100).toFixed(1) : '0.0';

        TradingLogger.info(
            `\n[DRY-RUN] ===== Hourly Status =====\n` +
            `  Balance: $${this.balance.toFixed(2)} (${pnlTotal.gte(0) ? '+' : ''}$${pnlTotal.toFixed(2)} / ${pnlPercent.gte(0) ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
            `  Open: ${openPosStr}\n` +
            `  Trades Today: ${tradesTodayCount} (${this.tradesToday.wins}W/${this.tradesToday.losses}L)\n` +
            `  Win Rate: ${winRate}%\n` +
            `================================`
        );
    }

    public async logDailySummary(): Promise<void> {
        const today = this.getDateString();
        const prevBalance = this.dailySummaries.length > 0
            ? this.dailySummaries[this.dailySummaries.length - 1].runningBalance
            : this.config.initialBalance.toNumber();

        const dayPnl = this.balance.toNumber() - prevBalance;
        const todayTrades = this.tradesToday.wins + this.tradesToday.losses;

        const summary: DailySummary = {
            date: today,
            trades: todayTrades,
            wins: this.tradesToday.wins,
            losses: this.tradesToday.losses,
            dayPnl: dayPnl,
            runningBalance: this.balance.toNumber()
        };

        this.dailySummaries.push(summary);

        const totalPnl = this.balance.sub(this.config.initialBalance);
        const totalPnlPercent = totalPnl.div(this.config.initialBalance).mul(100);
        const dayPnlPercent = (dayPnl / prevBalance) * 100;

        TradingLogger.info(
            `\n[DRY-RUN] ===== Daily Summary (${today}) =====\n` +
            `  Trades: ${todayTrades} | Wins: ${this.tradesToday.wins} | Losses: ${this.tradesToday.losses}\n` +
            `  Day P&L: ${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(2)} (${dayPnlPercent >= 0 ? '+' : ''}${dayPnlPercent.toFixed(2)}%)\n` +
            `  Running P&L: ${totalPnl.gte(0) ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPercent.gte(0) ? '+' : ''}${totalPnlPercent.toFixed(2)}%)\n` +
            `  Largest Win: $${this.stats.largestWin.toFixed(2)} | Largest Loss: $${this.stats.largestLoss.toFixed(2)}\n` +
            `  Near-Misses: ${this.nearMissCount} (3/4 stochastics aligned)\n` +
            `============================================`
        );

        // Reset daily counters
        this.tradesToday = { wins: 0, losses: 0 };
        this.nearMissCount = 0;
        this.lastDayReset = today;

        await this.persist();
    }

    private getDateString(): string {
        return new Date().toISOString().split('T')[0];
    }

    // ============================================================================
    // Persistence
    // ============================================================================

    private async persist(): Promise<void> {
        const state: DryRunState = {
            startTime: this.startTime.toISOString(),
            initialBalance: this.config.initialBalance.toNumber(),
            currentBalance: this.balance.toNumber(),
            trades: this.tradeHistory,
            stats: this.stats,
            dailySummaries: this.dailySummaries
        };

        try {
            const dir = path.dirname(this.config.dataPath);
            // Check if directory exists, create if not
            try {
                await fs.access(dir);
            } catch {
                // Directory doesn't exist, create it
                await fs.mkdir(dir, { recursive: true });
            }
            await fs.writeFile(this.config.dataPath, JSON.stringify(state, null, 2));
        } catch (error) {
            TradingLogger.error(`[DRY-RUN] Failed to persist state: ${(error as Error).message}`);
        }
    }

    private async loadState(): Promise<void> {
        try {
            // Check if state file exists
            try {
                await fs.access(this.config.dataPath);
            } catch {
                // File doesn't exist, nothing to load
                return;
            }

            const data = await fs.readFile(this.config.dataPath, 'utf8');
            const state: DryRunState = JSON.parse(data);

            // Restore state
            this.balance = new Decimal(state.currentBalance);
            this.tradeHistory = state.trades;
            this.stats = state.stats;
            this.dailySummaries = state.dailySummaries;
            this.startTime = new Date(state.startTime);

            TradingLogger.info(
                `[DRY-RUN] Loaded previous state: Balance $${this.balance.toFixed(2)}, ` +
                `${this.stats.totalTrades} trades, ${this.stats.wins}W/${this.stats.losses}L`
            );
        } catch (error) {
            TradingLogger.warn(`[DRY-RUN] Could not load previous state: ${(error as Error).message}`);
        }
    }

    // ============================================================================
    // Getters
    // ============================================================================

    public getBalance(): Decimal {
        return this.balance;
    }

    public getPosition(pair: TradingPair): DryRunTrade | undefined {
        return this.positions.get(pair);
    }

    public hasPosition(pair: TradingPair): boolean {
        return this.positions.has(pair);
    }

    public getPositionCount(): number {
        return this.positions.size;
    }

    public getStats(): DryRunStats {
        return { ...this.stats };
    }

    public isDryRunMode(): boolean {
        return true;
    }

    // ============================================================================
    // Cleanup
    // ============================================================================

    public async stop(): Promise<void> {
        if (this.hourlyInterval) {
            intervalManager.clearInterval(this.hourlyInterval);
        }
        if (this.dailyInterval) {
            intervalManager.clearInterval(this.dailyInterval);
        }
        await this.persist();
        TradingLogger.info('[DRY-RUN] Stopped and state persisted');
    }
}

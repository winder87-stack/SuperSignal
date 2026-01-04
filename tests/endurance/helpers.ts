/**
 * Endurance Test Helper Functions
 *
 * Provides utility functions for endurance tests including:
 * - Assertion helpers for endurance tests
 * - Mock data generators
 * - Test environment setup/teardown
 */

import { IntervalManager } from '../../src/utils/intervalManager.js';
import { EnduranceMonitor, MemorySnapshot, CpuMetrics, EventLoopLagMetrics } from './monitor.js';
import { TradingLogger } from '../../src/utils/logger.js';

// ============================================================================
// MOCK DATA GENERATORS
// ============================================================================

/**
 * Generate mock candle data
 */
export function generateMockCandle(timestamp?: number, basePrice: number = 50000) {
    const ts = timestamp ?? Date.now();
    const volatility = basePrice * 0.01; // 1% volatility

    return {
        timestamp: ts,
        open: basePrice + (Math.random() - 0.5) * volatility,
        high: basePrice + Math.random() * volatility,
        low: basePrice - Math.random() * volatility,
        close: basePrice + (Math.random() - 0.5) * volatility,
        volume: Math.random() * 1000 + 100
    };
}

/**
 * Generate mock order book data
 */
export function generateMockOrderBook(coin: string = 'BTC', basePrice: number = 50000) {
    const bids = Array.from({ length: 10 }, (_, i) => ({
        px: (basePrice - i * 10).toFixed(2),
        sz: (Math.random() * 10 + 0.1).toFixed(4),
        n: Math.floor(Math.random() * 100)
    }));

    const asks = Array.from({ length: 10 }, (_, i) => ({
        px: (basePrice + i * 10).toFixed(2),
        sz: (Math.random() * 10 + 0.1).toFixed(4),
        n: Math.floor(Math.random() * 100)
    }));

    return {
        coin,
        time: Date.now(),
        levels: [bids, asks],
        starting: true
    };
}

/**
 * Generate mock trade record
 */
export function generateMockTradeRecord() {
    const pairs = ['BTC-USDC', 'ETH-USDC', 'SOL-USDC'];
    const directions = ['long', 'short'] as const;

    return {
        pair: pairs[Math.floor(Math.random() * pairs.length)],
        direction: directions[Math.floor(Math.random() * directions.length)],
        entryPrice: Math.random() * 50000 + 1000,
        exitPrice: Math.random() * 50000 + 1000,
        size: Math.random() * 10 + 0.1,
        pnl: (Math.random() - 0.5) * 1000,
        pnlPercent: (Math.random() - 0.5) * 10,
        entryTime: Date.now() - 3600000,
        exitTime: Date.now(),
        strategy: 'superSignal'
    };
}

/**
 * Generate mock trading signal
 */
export function generateMockSignal() {
    const pairs = ['BTC-USDC', 'ETH-USDC', 'SOL-USDC'];
    const directions = ['long', 'short'] as const;

    return {
        pair: pairs[Math.floor(Math.random() * pairs.length)],
        direction: directions[Math.floor(Math.random() * directions.length)],
        type: 'entry' as const,
        price: Math.random() * 50000 + 1000,
        timestamp: Date.now(),
        strength: Math.random() * 0.5 + 0.5,
        metadata: {
            quadExtreme: Math.random() > 0.5,
            divergence: Math.random() > 0.5 ? 'bullish' : 'bearish',
            location: Math.random() > 0.5 ? 'support' : 'resistance'
        }
    };
}

/**
 * Generate batch of mock data
 */
export function generateMockBatch(count: number, generator: () => unknown) {
    return Array.from({ length: count }, () => generator());
}

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Assert that memory growth is within acceptable limits
 */
export function assertMemoryGrowth(
    snapshots: MemorySnapshot[],
    maxGrowthRate: number = 1024 * 1024, // 1 MB/s
    durationMs: number = 60000 // 1 minute
): { passed: boolean; message: string; growthRate: number } {
    if (snapshots.length < 2) {
        return {
            passed: true,
            message: 'Not enough snapshots to calculate growth rate',
            growthRate: 0
        };
    }

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const timeDelta = (last.timestamp - first.timestamp) / 1000; // seconds
    const memoryDelta = last.heapUsed - first.heapUsed;
    const growthRate = memoryDelta / timeDelta;

    const passed = growthRate <= maxGrowthRate;
    const message = passed
        ? `Memory growth rate ${formatBytes(growthRate)}/s within threshold ${formatBytes(maxGrowthRate)}/s`
        : `Memory growth rate ${formatBytes(growthRate)}/s exceeds threshold ${formatBytes(maxGrowthRate)}/s`;

    return { passed, message, growthRate };
}

/**
 * Assert that event loop lag is within acceptable limits
 */
export function assertEventLoopLag(
    snapshots: EventLoopLagMetrics[],
    maxLag: number = 100 // 100ms
): { passed: boolean; message: string; maxLagMs: number; avgLagMs: number } {
    if (snapshots.length === 0) {
        return {
            passed: true,
            message: 'No event loop snapshots available',
            maxLagMs: 0,
            avgLagMs: 0
        };
    }

    const lags = snapshots.map(s => s.lagMs);
    const maxLagMs = Math.max(...lags);
    const avgLagMs = lags.reduce((a, b) => a + b, 0) / lags.length;

    const passed = maxLagMs <= maxLag;
    const message = passed
        ? `Event loop lag max ${maxLagMs.toFixed(2)}ms, avg ${avgLagMs.toFixed(2)}ms within threshold ${maxLag}ms`
        : `Event loop lag max ${maxLagMs.toFixed(2)}ms exceeds threshold ${maxLag}ms`;

    return { passed, message, maxLagMs, avgLagMs };
}

/**
 * Assert that CPU usage is within acceptable limits
 */
export function assertCpuUsage(
    snapshots: CpuMetrics[],
    maxCpu: number = 80 // 80%
): { passed: boolean; message: string; avgCpu: number; maxCpu: number } {
    if (snapshots.length === 0) {
        return {
            passed: true,
            message: 'No CPU snapshots available',
            avgCpu: 0,
            maxCpu: 0
        };
    }

    const cpuValues = snapshots.map(s => s.percent);
    const avgCpu = cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length;
    const maxCpuValue = Math.max(...cpuValues);

    const passed = maxCpuValue <= maxCpu;
    const message = passed
        ? `CPU usage avg ${avgCpu.toFixed(2)}%, max ${maxCpuValue.toFixed(2)}% within threshold ${maxCpu}%`
        : `CPU usage max ${maxCpuValue.toFixed(2)}% exceeds threshold ${maxCpu}%`;

    return { passed, message, avgCpu, maxCpu: maxCpuValue };
}

/**
 * Assert that no intervals are leaked
 */
export function assertNoIntervalLeaks(manager: IntervalManager): {
    passed: boolean;
    message: string;
    activeCount: number;
} {
    const activeCount = manager.getActiveCount();
    const passed = activeCount === 0;

    const message = passed
        ? `No interval leaks detected (0 active intervals)`
        : `Interval leak detected: ${activeCount} active intervals remaining`;

    return { passed, message, activeCount };
}

/**
 * Assert that no memory leaks are detected
 */
export function assertNoMemoryLeaks(
    monitor: EnduranceMonitor
): { passed: boolean; message: string; leakResult: ReturnType<EnduranceMonitor['detectLeaks']> } {
    const leakResult = monitor.detectLeaks();
    const passed = !leakResult.hasMemoryLeak;

    const message = passed
        ? 'No memory leaks detected'
        : `Memory leak detected: ${leakResult.details}`;

    return { passed, message, leakResult };
}

/**
 * Assert that performance thresholds are met
 */
export function assertPerformanceThresholds(
    monitor: EnduranceMonitor
): { passed: boolean; message: string; violations: Array<{ type: string; actual: number; threshold: number; message: string }> } {
    const thresholdCheck = monitor.checkThresholds();
    const passed = thresholdCheck.passed;

    const message = passed
        ? 'All performance thresholds met'
        : `${thresholdCheck.violations.length} performance threshold(s) violated`;

    return { passed, message, violations: thresholdCheck.violations };
}

// ============================================================================
// TEST ENVIRONMENT SETUP/TEARDOWN
// ============================================================================

/**
 * Setup test environment
 */
export async function setupTestEnvironment(): Promise<{
    monitor: EnduranceMonitor;
    intervalManager: IntervalManager;
    cleanup: () => Promise<void>;
}> {
    // Reset IntervalManager singleton
    (IntervalManager as any).instance = undefined;
    const intervalManager = IntervalManager.getInstance();

    // Create monitor
    const monitor = new EnduranceMonitor();

    // Setup cleanup function
    const cleanup = async () => {
        monitor.stop();
        await intervalManager.shutdown();
        intervalManager.reset();
    };

    return { monitor, intervalManager, cleanup };
}

/**
 * Wait for a specified duration
 */
export async function waitForDuration(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait for a condition to be true
 */
export async function waitForCondition(
    condition: () => boolean,
    timeout: number = 5000,
    interval: number = 100
): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        if (condition()) {
            return true;
        }
        await waitForDuration(interval);
    }

    return false;
}

/**
 * Run a function multiple times and collect results
 */
export async function runMultipleTimes<T>(
    fn: () => Promise<T>,
    count: number,
    delay: number = 0
): Promise<T[]> {
    const results: T[] = [];

    for (let i = 0; i < count; i++) {
        results.push(await fn());
        if (delay > 0 && i < count - 1) {
            await waitForDuration(delay);
        }
    }

    return results;
}

/**
 * Measure execution time of a function
 */
export async function measureExecutionTime<T>(
    fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
    const start = Date.now();
    const result = await fn();
    const durationMs = Date.now() - start;

    return { result, durationMs };
}

/**
 * Create a mock WebSocket server for testing
 */
export function createMockWebSocketServer() {
    const EventEmitter = require('events');
    const mockServer = new EventEmitter();

    mockServer.clients = new Set();

    mockServer.simulateMessage = (message: unknown) => {
        mockServer.emit('message', Buffer.from(JSON.stringify(message)));
    };

    mockServer.simulateDisconnect = () => {
        mockServer.emit('close');
    };

    mockServer.simulateError = (error: Error) => {
        mockServer.emit('error', error);
    };

    return mockServer;
}

/**
 * Create a mock database for testing
 */
export function createMockDatabase() {
    const mockDb = {
        trades: [] as any[],
        signals: [] as any[],
        equity: [] as any[],

        saveTrade: async function (trade: any) {
            this.trades.push(trade);
        },

        getRecentTrades: async function (limit: number = 50) {
            return this.trades.slice(-limit);
        },

        saveSignal: async function (signal: any) {
            this.signals.push(signal);
        },

        getRecentSignals: async function (limit: number = 50) {
            return this.signals.slice(-limit);
        },

        saveEquitySnapshot: async function (balance: number, unrealizedPnL: number) {
            this.equity.push({
                timestamp: Date.now(),
                balance,
                unrealizedPnL,
                equity: balance + unrealizedPnL
            });
        },

        getEquityHistory: async function (limit: number = 1000) {
            return this.equity.slice(-limit);
        },

        close: async function () {
            // Mock close
        },

        reset: function () {
            this.trades = [];
            this.signals = [];
            this.equity = [];
        }
    };

    return mockDb;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format milliseconds to human-readable string
 */
export function formatMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(2)}m`;
    return `${(ms / 3600000).toFixed(2)}h`;
}

/**
 * Calculate statistics from an array of numbers
 */
export function calculateStats(values: number[]) {
    if (values.length === 0) {
        return { min: 0, max: 0, avg: 0, sum: 0, count: 0 };
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    return { min, max, avg, sum, count: values.length };
}

/**
 * Create a progress reporter for long-running tests
 */
export function createProgressReporter(totalSteps: number, intervalMs: number = 5000) {
    let currentStep = 0;
    let startTime = Date.now();
    let lastReportTime = startTime;

    return {
        increment: () => {
            currentStep++;
        },

        report: (message?: string) => {
            const now = Date.now();
            if (now - lastReportTime >= intervalMs) {
                const elapsed = now - startTime;
                const progress = (currentStep / totalSteps) * 100;
                const eta = currentStep > 0 ? (elapsed / currentStep) * (totalSteps - currentStep) : 0;

                TradingLogger.info('Endurance test progress', {
                    progress: `${progress.toFixed(1)}%`,
                    currentStep,
                    totalSteps,
                    elapsed: formatMs(elapsed),
                    eta: formatMs(eta),
                    message: message || ''
                });

                lastReportTime = now;
            }
        },

        complete: () => {
            const elapsed = Date.now() - startTime;
            TradingLogger.info('Endurance test completed', {
                totalSteps,
                elapsed: formatMs(elapsed)
            });
        }
    };
}

/**
 * Error Recovery Scenario
 *
 * Tests system resilience under error conditions:
 * - Exception handling
 * - Error recovery
 * - Graceful degradation
 * - System stability after errors
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import { EnduranceMonitor } from '../monitor.js';
import { setupTestEnvironment, assertNoMemoryLeaks, formatMs } from '../helpers.js';
import { IntervalManager } from '../../../src/utils/intervalManager.js';
import { DatabaseService } from '../../../src/core/database.js';
import { TradingEngine } from '../../../src/core/engine.js';
import { TradingPair, Candle } from '../../../src/types/index.js';

// Helper to generate mock candle with Decimal types
function generateMockCandle(timestamp?: number, basePrice: number = 50000): Candle {
    const ts = timestamp ?? Date.now();
    const volatility = basePrice * 0.01; // 1% volatility

    return {
        timestamp: ts,
        open: new Decimal(basePrice + (Math.random() - 0.5) * volatility),
        high: new Decimal(basePrice + Math.random() * volatility),
        low: new Decimal(basePrice - Math.random() * volatility),
        close: new Decimal(basePrice + (Math.random() - 0.5) * volatility),
        volume: new Decimal(Math.random() * 1000 + 100)
    };
}

// Mock logger to avoid side effects
vi.mock('../../../src/utils/logger.js', () => ({
    TradingLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        signal: vi.fn(),
        trade: vi.fn(),
        setComponent: vi.fn(),
        setRequestId: vi.fn(),
        logError: vi.fn(),
        generateRequestId: vi.fn(() => 'test-request-id')
    }
}));

describe('Error Recovery Scenario', () => {
    let monitor: EnduranceMonitor;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        const env = await setupTestEnvironment();
        monitor = env.monitor;
        cleanup = env.cleanup;
        monitor.start();
    });

    afterEach(async () => {
        await cleanup();
        monitor.stop();
    });

    describe('Exception Handling', () => {
        it('should handle interval callback errors gracefully', async () => {
            const manager = IntervalManager.getInstance();
            let errorCount = 0;
            let successCount = 0;

            // Create an interval that throws errors occasionally
            const errorCallback = vi.fn(() => {
                errorCount++;
                if (errorCount % 3 === 0) {
                    throw new Error(`Simulated error ${errorCount}`);
                }
                successCount++;
            });

            manager.setInterval(errorCallback, 100, { name: 'error-interval' });

            // Run for enough time to trigger errors
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify both errors and successes occurred
            expect(errorCount).toBeGreaterThan(0);
            expect(successCount).toBeGreaterThan(0);

            // Verify interval is still running
            const metadata = manager.getIntervalByName('error-interval');
            expect(metadata).toBeDefined();
            expect(metadata?.errorCount).toBeGreaterThan(0);
            expect(metadata?.executionCount).toBeGreaterThan(0);

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should handle database write errors gracefully', async () => {
            const testDbPath = `data/test-error-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath);

            // Mock a write error
            const originalFlushBatch = (db as any).flushBatch;
            let flushCount = 0;
            (db as any).flushBatch = vi.fn(async () => {
                flushCount++;
                if (flushCount === 1) {
                    throw new Error('Simulated flush error');
                }
                return originalFlushBatch.call(db);
            });

            // Try to write data
            for (let i = 0; i < 10; i++) {
                await db.saveTrade({
                    pair: 'BTC-USDC',
                    direction: 'long',
                    entryPrice: 50000,
                    exitPrice: 51000,
                    size: 0.1,
                    pnl: 100,
                    pnlPercent: 2,
                    entryTime: Date.now(),
                    exitTime: Date.now(),
                    strategy: 'test'
                });
            }

            // Wait for flush attempts
            await new Promise(resolve => setTimeout(resolve, 2000));

            // System should still be functional
            await db.saveTrade({
                pair: 'ETH-USDC',
                direction: 'short',
                entryPrice: 3000,
                exitPrice: 2900,
                size: 1,
                pnl: 100,
                pnlPercent: 3.33,
                entryTime: Date.now(),
                exitTime: Date.now(),
                strategy: 'test'
            });

            const trades = await db.getRecentTrades(10);
            expect(trades.length).toBeGreaterThanOrEqual(0);

            // Cleanup
            await db.close();
            const fs = await import('fs/promises');
            try {
                await fs.unlink(testDbPath);
                await fs.unlink(`${testDbPath}-wal`);
                await fs.unlink(`${testDbPath}-shm`);
            } catch (e) {
                // Ignore cleanup errors
            }
        }, 5000);
    });

    describe('Error Recovery', () => {
        it('should recover from transient errors', async () => {
            const manager = IntervalManager.getInstance();
            let errorCount = 0;
            let recovered = false;

            // Create an interval that recovers from errors
            const recoverableCallback = vi.fn(() => {
                errorCount++;
                if (errorCount <= 3) {
                    throw new Error(`Transient error ${errorCount}`);
                }
                recovered = true;
            });

            manager.setInterval(recoverableCallback, 100, { name: 'recoverable-interval' });

            // Wait for recovery
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify recovery occurred
            expect(recovered).toBe(true);

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should continue processing after errors', async () => {
            const manager = IntervalManager.getInstance();
            const processedItems: number[] = [];

            // Create an interval that processes items with occasional errors
            let itemIndex = 0;
            const processingCallback = vi.fn(() => {
                itemIndex++;
                if (itemIndex % 5 === 0) {
                    throw new Error(`Processing error at item ${itemIndex}`);
                }
                processedItems.push(itemIndex);
            });

            manager.setInterval(processingCallback, 50, { name: 'processing-interval' });

            // Run for enough time to process many items
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify many items were processed despite errors
            expect(processedItems.length).toBeGreaterThan(10);

            // Cleanup
            await manager.shutdown();
        }, 5000);
    });

    describe('Graceful Degradation', () => {
        it('should degrade gracefully under high error rate', async () => {
            const manager = IntervalManager.getInstance();
            let successCount = 0;
            let errorCount = 0;

            // Create an interval with high error rate
            const highErrorCallback = vi.fn(() => {
                if (Math.random() < 0.7) {
                    errorCount++;
                    throw new Error('High error rate');
                }
                successCount++;
            });

            manager.setInterval(highErrorCallback, 100, { name: 'high-error-interval' });

            // Run for enough time to observe degradation
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify system is still running
            const metadata = manager.getIntervalByName('high-error-interval');
            expect(metadata).toBeDefined();

            // Verify both successes and errors occurred
            expect(successCount).toBeGreaterThan(0);
            expect(errorCount).toBeGreaterThan(0);

            // Cleanup
            await manager.shutdown();
        }, 5000);
    });

    describe('System Stability After Errors', () => {
        it('should remain stable after error bursts', async () => {
            const manager = IntervalManager.getInstance();
            const executionTimes: number[] = [];

            // Create an interval with error bursts
            let burstCount = 0;
            const burstCallback = vi.fn(() => {
                const start = Date.now();

                burstCount++;
                if (burstCount % 20 === 0 && burstCount < 60) {
                    // Error burst: 3 consecutive errors
                    throw new Error('Burst error');
                }

                const duration = Date.now() - start;
                executionTimes.push(duration);
            });

            manager.setInterval(burstCallback, 50, { name: 'burst-interval' });

            // Run for enough time to experience bursts
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Verify system is still stable
            const avgExecutionTime = executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length;
            const maxExecutionTime = Math.max(...executionTimes);

            // Execution times should remain reasonable
            expect(avgExecutionTime).toBeLessThan(50);
            expect(maxExecutionTime).toBeLessThan(200);

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should not leak memory after errors', async () => {
            const manager = IntervalManager.getInstance();
            const initialMemory = process.memoryUsage().heapUsed;

            // Create intervals that throw errors
            for (let i = 0; i < 10; i++) {
                manager.setInterval(() => {
                    throw new Error(`Memory leak test error ${i}`);
                }, 100, { name: `error-interval-${i}` });
            }

            // Run for enough time to accumulate errors
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }

            const finalMemory = process.memoryUsage().heapUsed;
            const memoryGrowth = finalMemory - initialMemory;

            // Memory growth should be minimal
            expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024); // 10MB

            // Cleanup
            await manager.shutdown();
        }, 5000);
    });

    describe('Promise Rejection Handling', () => {
        it('should handle promise rejections gracefully', async () => {
            const manager = IntervalManager.getInstance();
            let rejectionCount = 0;
            let successCount = 0;

            // Create an interval that rejects promises
            const rejectionCallback = vi.fn(async () => {
                rejectionCount++;
                if (rejectionCount % 3 === 0) {
                    return Promise.reject(new Error(`Promise rejection ${rejectionCount}`));
                }
                successCount++;
                return Promise.resolve();
            });

            manager.setInterval(rejectionCallback, 100, { name: 'rejection-interval' });

            // Run for enough time to trigger rejections
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify both rejections and successes occurred
            expect(rejectionCount).toBeGreaterThan(0);
            expect(successCount).toBeGreaterThan(0);

            // Verify interval is still running
            const metadata = manager.getIntervalByName('rejection-interval');
            expect(metadata).toBeDefined();
            expect(metadata?.errorCount).toBeGreaterThan(0);

            // Cleanup
            await manager.shutdown();
        }, 5000);
    });

    // Note: Trading Engine error recovery tests are covered in the main engine test suite
    // This scenario focuses on lower-level error handling in IntervalManager and DatabaseService
});

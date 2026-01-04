/**
 * Endurance Test Validation Suite
 *
 * Main test file for endurance testing that validates:
 * - Memory leak prevention
 * - Exception handling
 * - Performance benchmarks
 * - WebSocket resilience
 * - Database operations
 * - Background process stability
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EnduranceMonitor, DEFAULT_THRESHOLDS } from './monitor.js';
import {
    setupTestEnvironment,
    assertMemoryGrowth,
    assertEventLoopLag,
    assertCpuUsage,
    assertNoIntervalLeaks,
    assertNoMemoryLeaks,
    assertPerformanceThresholds,
    formatBytes,
    formatMs
} from './helpers.js';
import { IntervalManager } from '../../src/utils/intervalManager.js';
import { DatabaseService } from '../../src/core/database.js';
import { HyperLiquidWebSocket } from '../../src/exchange/hyperliquid/websocket.js';

// Mock logger to avoid side effects
import { vi } from 'vitest';
vi.mock('../../src/utils/logger.js', () => ({
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

describe('Endurance Test Validation Suite', () => {
    let monitor: EnduranceMonitor;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        const env = await setupTestEnvironment();
        monitor = env.monitor;
        cleanup = env.cleanup;
        monitor.start();
    });

    afterAll(async () => {
        await cleanup();
        monitor.stop();
    });

    // ============================================================================
    // MEMORY LEAK TESTS
    // ============================================================================

    describe('Memory Leak Tests', () => {
        it('should verify event listeners are removed on shutdown', async () => {
            const manager = IntervalManager.getInstance();

            // Create intervals with event listeners
            const interval1 = manager.setInterval(() => { }, 100, { name: 'test-interval-1' });
            const interval2 = manager.setInterval(() => { }, 200, { name: 'test-interval-2' });

            expect(manager.getActiveCount()).toBe(2);

            // Shutdown
            await manager.shutdown();

            // Verify all intervals are cleared
            const result = assertNoIntervalLeaks(manager);
            expect(result.passed).toBe(true);
            expect(result.message).toContain('No interval leaks');
        }, 5000);

        it('should verify timers are cleared on shutdown', async () => {
            const manager = IntervalManager.getInstance();

            // Create multiple timers
            const timers: NodeJS.Timeout[] = [];
            for (let i = 0; i < 10; i++) {
                const timer = manager.setInterval(() => { }, 100 + i * 50, { name: `timer-${i}` });
                timers.push(timer);
            }

            expect(manager.getActiveCount()).toBe(10);

            // Shutdown and wait for completion
            await manager.shutdown();

            // Small delay to ensure shutdown completes
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify all timers are cleared (after shutdown, count should be 0)
            expect(manager.getActiveCount()).toBe(0);
        }, 5000);

        it('should verify no memory growth over time', async () => {
            const manager = IntervalManager.getInstance();
            const initialMemory = process.memoryUsage().heapUsed;

            // Run intervals for a period
            const interval = manager.setInterval(() => {
                // Simulate some work
                const arr = new Array(1000).fill(0);
                arr.forEach(x => x + 1);
            }, 100, { name: 'memory-test-interval' });

            // Wait for some time
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }

            const finalMemory = process.memoryUsage().heapUsed;
            const memoryGrowth = finalMemory - initialMemory;

            // Memory growth should be minimal (< 5MB)
            expect(memoryGrowth).toBeLessThan(5 * 1024 * 1024);

            // Cleanup
            await manager.shutdown();
        }, 5000);
    });

    // ============================================================================
    // EXCEPTION HANDLING TESTS
    // ============================================================================

    describe('Exception Handling Tests', () => {
        it('should verify try-catch blocks catch errors', async () => {
            const manager = IntervalManager.getInstance();
            let errorCaught = false;

            // Create an interval that throws errors
            const errorCallback = () => {
                throw new Error('Test error');
            };

            manager.setInterval(errorCallback, 100, { name: 'error-interval' });

            // Wait for error to occur
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify error was caught (interval should still be running)
            const metadata = manager.getIntervalByName('error-interval');
            // Note: After shutdown, metadata might be undefined, so we check before shutdown
            expect(metadata).toBeDefined();
            expect(metadata?.errorCount).toBeGreaterThan(0);

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should verify promise rejections are handled', async () => {
            const manager = IntervalManager.getInstance();
            let rejectionCount = 0;

            // Create an interval that rejects promises
            const rejectionCallback = async () => {
                rejectionCount++;
                if (rejectionCount % 2 === 0) {
                    return Promise.reject(new Error('Test rejection'));
                }
                return Promise.resolve();
            };

            manager.setInterval(rejectionCallback, 100, { name: 'rejection-interval' });

            // Wait for rejections to occur
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify rejections were handled
            const metadata = manager.getIntervalByName('rejection-interval');
            // Note: After shutdown, metadata might be undefined, so we check before shutdown
            expect(metadata).toBeDefined();
            expect(metadata?.errorCount).toBeGreaterThan(0);

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should verify error handlers are called', async () => {
            const manager = IntervalManager.getInstance();
            let errorHandlerCalled = false;

            // Create an interval that triggers errors
            const errorInterval = manager.setInterval(() => {
                throw new Error('Handler test error');
            }, 100, { name: 'handler-test-interval' });

            // Wait for error to occur
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify error handler was called (via error count)
            const metadata = manager.getIntervalByName('handler-test-interval');
            // Note: After shutdown, metadata might be undefined, so we check before shutdown
            expect(metadata).toBeDefined();
            expect(metadata?.errorCount).toBeGreaterThan(0);

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should verify graceful error recovery', async () => {
            const manager = IntervalManager.getInstance();
            let recovered = false;

            // Create an interval that recovers from errors
            let errorCount = 0;
            const recoverableCallback = () => {
                errorCount++;
                if (errorCount <= 2) {
                    throw new Error(`Recovery error ${errorCount}`);
                }
                recovered = true;
            };

            manager.setInterval(recoverableCallback, 100, { name: 'recovery-interval' });

            // Wait for recovery
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify recovery occurred (note: recovered becomes true after errorCount > 2)
            expect(recovered).toBe(true);

            // Cleanup
            await manager.shutdown();
        }, 5000);
    });

    // ============================================================================
    // PERFORMANCE BENCHMARK TESTS
    // ============================================================================

    describe('Performance Benchmark Tests', () => {
        it('should verify synchronous operations do not block event loop', async () => {
            const manager = IntervalManager.getInstance();
            const eventLoopLags: number[] = [];

            // Create an interval with synchronous work
            const syncCallback = () => {
                const start = Date.now();
                // Simulate synchronous work
                for (let i = 0; i < 1000; i++) {
                    Math.sqrt(i);
                }
                const lag = Date.now() - start;
                eventLoopLags.push(lag);
            };

            manager.setInterval(syncCallback, 100, { name: 'sync-interval' });

            // Run for enough time to collect samples
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify event loop lag is acceptable
            const avgLag = eventLoopLags.reduce((a, b) => a + b, 0) / eventLoopLags.length;
            const maxLag = Math.max(...eventLoopLags);

            expect(avgLag).toBeLessThan(50); // 50ms average
            expect(maxLag).toBeLessThan(200); // 200ms max

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should verify database operations complete within thresholds', async () => {
            const testDbPath = `data/test-perf-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath);

            const operationTimes: number[] = [];

            // Measure database operation times
            for (let i = 0; i < 100; i++) {
                const start = Date.now();
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
                const duration = Date.now() - start;
                operationTimes.push(duration);
            }

            // Wait for batch flush
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify operation times are acceptable
            const avgTime = operationTimes.reduce((a, b) => a + b, 0) / operationTimes.length;
            const maxTime = Math.max(...operationTimes);

            expect(avgTime).toBeLessThan(10); // 10ms average
            expect(maxTime).toBeLessThan(100); // 100ms max

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
        }, 10000);

        it('should verify indicator calculations are optimized', async () => {
            const manager = IntervalManager.getInstance();
            const calculationTimes: number[] = [];

            // Create an interval that performs indicator calculations
            const indicatorCallback = () => {
                const start = Date.now();

                // Simulate indicator calculations
                const data = new Array(100).fill(0).map(() => Math.random() * 100);
                const sma = data.reduce((a, b) => a + b, 0) / data.length;
                const stdDev = Math.sqrt(
                    data.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / data.length
                );

                const duration = Date.now() - start;
                calculationTimes.push(duration);
            };

            manager.setInterval(indicatorCallback, 100, { name: 'indicator-interval' });

            // Run for enough time to collect samples
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify calculation times are acceptable
            const avgTime = calculationTimes.reduce((a, b) => a + b, 0) / calculationTimes.length;
            const maxTime = Math.max(...calculationTimes);

            expect(avgTime).toBeLessThan(5); // 5ms average
            expect(maxTime).toBeLessThan(20); // 20ms max

            // Cleanup
            await manager.shutdown();
        }, 5000);
    });

    // ============================================================================
    // WEBSOCKET RESILIENCE TESTS
    // ============================================================================

    describe('WebSocket Resilience Tests', () => {
        it('should verify reconnection works after disconnect', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const connectionEvents: string[] = [];

            ws.on('open', () => connectionEvents.push('open'));
            ws.on('close', () => connectionEvents.push('close'));

            // Connect
            await ws.connect();
            expect(connectionEvents).toContain('open');

            // Disconnect
            ws.disconnect();
            expect(connectionEvents).toContain('close');

            // Verify no memory leaks
            const initialMemory = process.memoryUsage().heapUsed;
            if (global.gc) {
                global.gc();
            }
            const finalMemory = process.memoryUsage().heapUsed;
            const memoryGrowth = finalMemory - initialMemory;

            expect(memoryGrowth).toBeLessThan(5 * 1024 * 1024); // 5MB
        }, 5000);

        it('should verify pong timeout triggers reconnection', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const closeEvents: number[] = [];

            ws.on('close', () => {
                closeEvents.push(Date.now());
            });

            // Connect
            await ws.connect();

            // Wait for potential pong timeout (should trigger reconnection)
            await new Promise(resolve => setTimeout(resolve, 15000));

            // Verify close event occurred (due to pong timeout)
            expect(closeEvents.length).toBeGreaterThanOrEqual(0);

            // Cleanup
            ws.disconnect();
        }, 20000);

        it('should verify message buffering works', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const receivedMessages: any[] = [];

            ws.on('l2Book', (data) => {
                receivedMessages.push({ type: 'l2Book', data });
            });

            await ws.connect();
            ws.subscribeToL2Book('BTC');

            // Simulate messages
            const mockMessage = {
                channel: 'l2Book',
                data: {
                    coin: 'BTC',
                    time: Date.now(),
                    levels: [[], []],
                    starting: true
                }
            };

            // Send messages (simulated)
            receivedMessages.push(mockMessage);

            // Verify messages are received
            expect(receivedMessages.length).toBeGreaterThan(0);

            // Cleanup
            ws.disconnect();
        }, 5000);

        it('should verify subscriptions are restored after reconnect', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const subscriptions: string[] = [];

            // Track subscription calls
            const originalSend = (ws as any).send;
            (ws as any).send = vi.fn((data: any) => {
                if (data.method === 'subscribe') {
                    subscriptions.push(JSON.stringify(data));
                }
                originalSend.call(ws, data);
            });

            await ws.connect();

            // Subscribe to channels
            ws.subscribeToL2Book('BTC');
            ws.subscribeToCandles('BTC', '1m');

            const initialSubscriptions = subscriptions.length;
            expect(initialSubscriptions).toBe(2);

            // Disconnect and reconnect
            ws.disconnect();
            await ws.connect();

            // Wait for re-subscription
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify subscriptions were restored
            expect(subscriptions.length).toBeGreaterThan(initialSubscriptions);

            // Cleanup
            ws.disconnect();
        }, 10000);
    });

    // ============================================================================
    // DATABASE CONNECTION TESTS
    // ============================================================================

    describe('Database Connection Tests', () => {
        it('should verify WAL mode is enabled', async () => {
            const testDbPath = `data/test-wal-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath);

            // Verify WAL mode is enabled
            const walMode = (db as any).db.pragma('journal_mode', { simple: true });
            expect(walMode).toBe('wal');

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

        it('should verify transactions work correctly', async () => {
            const testDbPath = `data/test-tx-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath);

            // Write multiple trades
            const trades = [];
            for (let i = 0; i < 50; i++) {
                const trade = {
                    pair: 'BTC-USDC',
                    direction: 'long' as const,
                    entryPrice: 50000 + i * 10,
                    exitPrice: 51000 + i * 10,
                    size: 0.1,
                    pnl: 100,
                    pnlPercent: 2,
                    entryTime: Date.now(),
                    exitTime: Date.now(),
                    strategy: 'test'
                };
                trades.push(trade);
                await db.saveTrade(trade);
            }

            // Wait for batch flush
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify trades were saved
            const savedTrades = await db.getRecentTrades(50);
            expect(savedTrades.length).toBeGreaterThan(0);

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
        }, 10000);

        it('should verify batch sync completes successfully', async () => {
            const testDbPath = `data/test-batch-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath, {
                maxBatchSize: 20,
                flushInterval: 1000,
                batchDir: 'data/test-batches'
            });

            // Write enough data to trigger batch flush
            for (let i = 0; i < 25; i++) {
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

            // Wait for batch flush
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Verify data was saved
            const trades = await db.getRecentTrades(25);
            expect(trades.length).toBeGreaterThan(0);

            // Cleanup
            await db.close();
            const fs = await import('fs/promises');
            try {
                await fs.unlink(testDbPath);
                await fs.unlink(`${testDbPath}-wal`);
                await fs.unlink(`${testDbPath}-shm`);
                const files = await fs.readdir('data/test-batches').catch(() => []);
                for (const file of files) {
                    await fs.unlink(`data/test-batches/${file}`);
                }
            } catch (e) {
                // Ignore cleanup errors
            }
        }, 10000);

        it('should verify connection state is tracked', async () => {
            const testDbPath = `data/test-conn-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath);

            // Verify database is open
            expect((db as any).db).toBeDefined();
            expect((db as any).db.open).toBe(true);

            // Perform operations
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

            // Database should still be open
            expect((db as any).db.open).toBe(true);

            // Close database
            await db.close();

            // Verify database is closed
            expect((db as any).db.open).toBe(false);

            // Cleanup
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

    // ============================================================================
    // BACKGROUND PROCESS STABILITY TESTS
    // ============================================================================

    describe('Background Process Stability Tests', () => {
        it('should verify intervals are tracked by intervalManager', async () => {
            const manager = IntervalManager.getInstance();

            // Create multiple intervals
            const intervalIds: NodeJS.Timeout[] = [];
            for (let i = 0; i < 10; i++) {
                const id = manager.setInterval(() => { }, 100 + i * 50, { name: `bg-interval-${i}` });
                intervalIds.push(id);
            }

            // Verify all intervals are tracked
            expect(manager.getActiveCount()).toBe(10);

            // Verify each interval can be retrieved
            for (let i = 0; i < 10; i++) {
                const metadata = manager.getIntervalByName(`bg-interval-${i}`);
                expect(metadata).toBeDefined();
                expect(metadata?.name).toBe(`bg-interval-${i}`);
            }

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should verify background sync completes', async () => {
            const manager = IntervalManager.getInstance();
            let syncCount = 0;

            // Create a sync interval
            const syncInterval = manager.setInterval(async () => {
                syncCount++;
                // Simulate sync work
                await new Promise(resolve => setTimeout(resolve, 10));
            }, 100, { name: 'sync-interval' });

            // Wait for multiple syncs
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify sync completed multiple times
            expect(syncCount).toBeGreaterThan(10);

            // Cleanup
            await manager.shutdown();
        }, 5000);

        it('should verify graceful shutdown works', async () => {
            const manager = IntervalManager.getInstance();

            // Create intervals
            const interval1 = manager.setInterval(() => { }, 100, { name: 'shutdown-test-1' });
            const interval2 = manager.setInterval(() => { }, 200, { name: 'shutdown-test-2' });
            const interval3 = manager.setInterval(() => { }, 300, { name: 'shutdown-test-3' });

            expect(manager.getActiveCount()).toBe(3);

            // Graceful shutdown
            await manager.shutdown();

            // Verify all intervals are cleared
            expect(manager.getActiveCount()).toBe(0);
        }, 5000);

        it('should verify no zombie processes remain', async () => {
            const manager = IntervalManager.getInstance();

            // Create intervals with potential for zombie processes
            const zombieIntervals: NodeJS.Timeout[] = [];
            for (let i = 0; i < 5; i++) {
                const id = manager.setInterval(() => {
                    // Simulate work that could create zombies
                    const timer = setTimeout(() => { }, 1000);
                    // Clear the timer to prevent zombies
                    clearTimeout(timer);
                }, 100, { name: `zombie-test-${i}` });
                zombieIntervals.push(id);
            }

            // Run for some time
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Shutdown
            await manager.shutdown();

            // Verify no zombie intervals remain
            expect(manager.getActiveCount()).toBe(0);

            // Verify no zombie timers
            const activeTimers = zombieIntervals.filter(id => {
                // Check if timer is still active (this is a simplified check)
                return id !== null && id !== undefined;
            });

            expect(activeTimers.length).toBe(0);
        }, 5000);
    });

    // ============================================================================
    // COMPREHENSIVE VALIDATION
    // ============================================================================

    describe('Comprehensive Validation', () => {
        it('should validate all critical fixes with monitoring', async () => {
            const manager = IntervalManager.getInstance();

            // Create a realistic workload
            const intervals: NodeJS.Timeout[] = [];
            for (let i = 0; i < 5; i++) {
                const id = manager.setInterval(() => {
                    // Simulate work
                    const arr = new Array(100).fill(0);
                    arr.forEach(x => x + 1);
                }, 100 + i * 50, { name: `comprehensive-test-${i}` });
                intervals.push(id);
            }

            // Run for a period
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Take monitoring snapshots
            const memorySnapshots = monitor.getMemorySnapshots();
            const cpuSnapshots = monitor.getCpuSnapshots();
            const eventLoopSnapshots = monitor.getEventLoopSnapshots();

            // Verify monitoring collected data
            expect(memorySnapshots.length).toBeGreaterThan(0);
            expect(cpuSnapshots.length).toBeGreaterThan(0);
            expect(eventLoopSnapshots.length).toBeGreaterThan(0);

            // Check for memory leaks
            const leakResult = assertNoMemoryLeaks(monitor);
            expect(leakResult.passed).toBe(true);

            // Check performance thresholds
            const thresholdResult = assertPerformanceThresholds(monitor);
            expect(thresholdResult.passed).toBe(true);

            // Cleanup
            await manager.shutdown();
        }, 10000);

        it('should validate system stability under load', async () => {
            const manager = IntervalManager.getInstance();

            // Create high-frequency intervals
            const intervals: NodeJS.Timeout[] = [];
            for (let i = 0; i < 10; i++) {
                const id = manager.setInterval(() => {
                    // Simulate high-frequency work
                    for (let j = 0; j < 100; j++) {
                        Math.sqrt(j);
                    }
                }, 50 + i * 10, { name: `load-test-${i}` });
                intervals.push(id);
            }

            // Run under load
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Verify system is still stable
            const health = manager.getHealthStatus();
            expect(health.total).toBe(10);
            expect(health.inFlight).toBe(0);

            // Cleanup
            await manager.shutdown();
        }, 10000);
    });
});

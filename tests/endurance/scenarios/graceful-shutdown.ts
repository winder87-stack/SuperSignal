/**
 * Graceful Shutdown Scenario
 *
 * Tests graceful shutdown behavior:
 * - Interval cleanup
 * - Database connection closure
 * - WebSocket disconnection
 * - Resource release
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnduranceMonitor } from '../monitor.js';
import { setupTestEnvironment, assertNoIntervalLeaks, waitForCondition } from '../helpers.js';
import { IntervalManager } from '../../../src/utils/intervalManager.js';
import { DatabaseService } from '../../../src/core/database.js';
import { HyperLiquidWebSocket } from '../../../src/exchange/hyperliquid/websocket.js';

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

describe('Graceful Shutdown Scenario', () => {
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

    describe('Interval Cleanup', () => {
        it('should clear all intervals on shutdown', async () => {
            const manager = IntervalManager.getInstance();

            // Create multiple intervals
            const interval1 = manager.setInterval(() => { }, 100, { name: 'interval-1' });
            const interval2 = manager.setInterval(() => { }, 200, { name: 'interval-2' });
            const interval3 = manager.setInterval(() => { }, 300, { name: 'interval-3' });

            expect(manager.getActiveCount()).toBe(3);

            // Shutdown
            await manager.shutdown();

            // Verify all intervals are cleared
            const result = assertNoIntervalLeaks(manager);
            expect(result.passed).toBe(true);
        }, 5000);

        it('should wait for in-flight executions before clearing', async () => {
            const manager = IntervalManager.getInstance();
            let executionCount = 0;
            let inFlightResolved = false;

            // Create an interval with slow execution
            const slowCallback = vi.fn(() => {
                executionCount++;
                return new Promise<void>(resolve => {
                    setTimeout(() => {
                        inFlightResolved = true;
                        resolve();
                    }, 100);
                });
            });

            manager.setInterval(slowCallback, 50, { name: 'slow-interval' });

            // Wait for execution to start
            await waitForCondition(() => executionCount > 0, 1000);

            // Shutdown while execution is in-flight
            await manager.shutdown();

            // Verify in-flight execution completed
            expect(inFlightResolved).toBe(true);
        }, 5000);

        it('should prevent new intervals after shutdown', async () => {
            const manager = IntervalManager.getInstance();

            // Shutdown
            await manager.shutdown();

            // Try to create new interval
            const newInterval = manager.setInterval(() => { }, 100, { name: 'new-interval' });

            // New interval should not be registered
            expect(manager.getActiveCount()).toBe(0);
        }, 5000);
    });

    describe('Database Connection Closure', () => {
        it('should close database connection gracefully', async () => {
            const testDbPath = `data/test-shutdown-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath);

            // Write some data
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

            // Close database
            await db.close();

            // Verify database is closed
            expect((db as any).db.open).toBe(false);

            // Clean up
            const fs = await import('fs/promises');
            try {
                await fs.unlink(testDbPath);
                await fs.unlink(`${testDbPath}-wal`);
                await fs.unlink(`${testDbPath}-shm`);
            } catch (e) {
                // Ignore cleanup errors
            }
        }, 5000);

        it('should flush pending batch data before closing', async () => {
            const testDbPath = `data/test-shutdown-batch-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath, {
                maxBatchSize: 100,
                flushInterval: 5000,
                batchDir: 'data/test-batches'
            });

            // Write data that won't trigger immediate flush
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

            // Close database (should flush pending data)
            await db.close();

            // Verify data was saved
            const fs = await import('fs/promises');
            const files = await fs.readdir('data/test-batches').catch(() => []);

            // Should have batch files
            expect(files.length).toBeGreaterThan(0);

            // Clean up
            try {
                await fs.unlink(testDbPath);
                await fs.unlink(`${testDbPath}-wal`);
                await fs.unlink(`${testDbPath}-shm`);
                for (const file of files) {
                    await fs.unlink(`data/test-batches/${file}`);
                }
            } catch (e) {
                // Ignore cleanup errors
            }
        }, 5000);
    });

    describe('WebSocket Disconnection', () => {
        it('should disconnect WebSocket gracefully', async () => {
            const ws = new HyperLiquidWebSocket(false);
            let disconnected = false;

            ws.on('close', () => {
                disconnected = true;
            });

            // Connect
            await ws.connect();

            // Disconnect
            ws.disconnect();

            // Verify disconnection
            expect(disconnected).toBe(true);
        }, 5000);

        it('should remove all event listeners on disconnect', async () => {
            const ws = new HyperLiquidWebSocket(false);

            // Connect and add listeners
            await ws.connect();
            ws.on('l2Book', () => { });
            ws.on('candle', () => { });

            const listenerCountBefore = ws.listenerCount('l2Book') + ws.listenerCount('candle');
            expect(listenerCountBefore).toBeGreaterThan(0);

            // Disconnect
            ws.disconnect();

            // Verify listeners are removed
            const listenerCountAfter = ws.listenerCount('l2Book') + ws.listenerCount('candle');
            expect(listenerCountAfter).toBe(0);
        }, 5000);

        it('should stop ping interval on disconnect', async () => {
            const ws = new HyperLiquidWebSocket(false);

            // Connect
            await ws.connect();

            // Verify ping interval is active
            expect((ws as any).pingInterval).not.toBeNull();

            // Disconnect
            ws.disconnect();

            // Verify ping interval is cleared
            expect((ws as any).pingInterval).toBeNull();
        }, 5000);
    });

    describe('Resource Release', () => {
        it('should release all resources on shutdown', async () => {
            const manager = IntervalManager.getInstance();
            const testDbPath = `data/test-resource-${Date.now()}.db`;
            const db = new DatabaseService(testDbPath);

            // Create intervals
            manager.setInterval(() => { }, 100, { name: 'interval-1' });
            manager.setInterval(() => { }, 200, { name: 'interval-2' });

            // Write data
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

            // Shutdown all components
            await manager.shutdown();
            await db.close();

            // Verify all resources are released
            expect(manager.getActiveCount()).toBe(0);
            expect((db as any).db.open).toBe(false);

            // Clean up
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

    describe('Memory Cleanup', () => {
        it('should clean up memory on shutdown', async () => {
            const manager = IntervalManager.getInstance();
            const initialMemory = process.memoryUsage().heapUsed;

            // Create many intervals
            for (let i = 0; i < 100; i++) {
                manager.setInterval(() => { }, 100, { name: `interval-${i}` });
            }

            // Shutdown
            await manager.shutdown();

            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }

            const finalMemory = process.memoryUsage().heapUsed;
            const memoryGrowth = finalMemory - initialMemory;

            // Memory growth should be minimal (< 5MB)
            expect(memoryGrowth).toBeLessThan(5 * 1024 * 1024);
        }, 10000);
    });

    describe('Error Handling During Shutdown', () => {
        it('should handle errors during shutdown gracefully', async () => {
            const manager = IntervalManager.getInstance();

            // Create an interval that throws on shutdown
            let callCount = 0;
            const errorCallback = vi.fn(() => {
                callCount++;
                if (callCount > 5) {
                    throw new Error('Shutdown error');
                }
            });

            manager.setInterval(errorCallback, 100, { name: 'error-interval' });

            // Shutdown (should handle errors gracefully)
            await manager.shutdown();

            // Verify shutdown completed despite errors
            expect(manager.getActiveCount()).toBe(0);
        }, 5000);
    });
});

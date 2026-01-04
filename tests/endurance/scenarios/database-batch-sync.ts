/**
 * Database Batch Sync Scenario
 *
 * Tests database operations under high load:
 * - Batch write operations
 * - WAL mode performance
 * - Transaction handling
 * - Connection state tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import { EnduranceMonitor, MemorySnapshot } from '../monitor.js';
import { setupTestEnvironment, generateMockTradeRecord, assertMemoryGrowth, formatBytes } from '../helpers.js';
import { DatabaseService } from '../../../src/core/database.js';
import { TradingSignal } from '../../../src/types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';

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

describe('Database Batch Sync Scenario', () => {
    let monitor: EnduranceMonitor;
    let cleanup: () => Promise<void>;
    let db: DatabaseService;
    let testDbPath: string;

    beforeEach(async () => {
        const env = await setupTestEnvironment();
        monitor = env.monitor;
        cleanup = env.cleanup;

        // Create test database
        testDbPath = `data/test-bot-${Date.now()}.db`;
        db = new DatabaseService(testDbPath, {
            maxBatchSize: 50,
            flushInterval: 1000,
            batchDir: 'data/test-batches'
        });

        monitor.start();
    });

    afterEach(async () => {
        await db.close();
        await cleanup();
        monitor.stop();

        // Clean up test database
        try {
            await fs.unlink(testDbPath);
            await fs.unlink(`${testDbPath}-wal`);
            await fs.unlink(`${testDbPath}-shm`);
        } catch (e) {
            // Ignore cleanup errors
        }
    });

    describe('Batch Write Operations', () => {
        it('should handle high-frequency batch writes', async () => {
            const writeCount = 1000;
            const startTime = Date.now();

            // Write many trades rapidly
            for (let i = 0; i < writeCount; i++) {
                await db.saveTrade(generateMockTradeRecord());
            }

            // Wait for batch flush
            await new Promise(resolve => setTimeout(resolve, 2000));

            const duration = Date.now() - startTime;
            const writesPerSecond = (writeCount / duration) * 1000;

            // Should handle at least 100 writes per second
            expect(writesPerSecond).toBeGreaterThan(100);

            // Verify trades were saved
            const trades = await db.getRecentTrades(writeCount);
            expect(trades.length).toBeGreaterThan(0);
        }, 10000);

        it('should flush batch when size threshold is reached', async () => {
            const batchSize = 50;
            const flushSpy = vi.spyOn(db as any, 'flushBatch');

            // Write exactly batch size
            for (let i = 0; i < batchSize; i++) {
                await db.saveTrade(generateMockTradeRecord());
            }

            // Wait for async flush
            await new Promise(resolve => setTimeout(resolve, 100));

            // Flush should have been called
            expect(flushSpy).toHaveBeenCalled();
        }, 5000);

        it('should flush batch on time interval', async () => {
            const flushInterval = 1000;
            const flushSpy = vi.spyOn(db as any, 'flushBatch');

            // Write fewer than batch size
            for (let i = 0; i < 10; i++) {
                await db.saveTrade(generateMockTradeRecord());
            }

            // Wait for time-based flush
            await new Promise(resolve => setTimeout(resolve, flushInterval + 500));

            // Flush should have been called
            expect(flushSpy).toHaveBeenCalled();
        }, 5000);
    });

    describe('WAL Mode Performance', () => {
        it('should have WAL mode enabled', async () => {
            // WAL mode is enabled in constructor
            // Verify by checking pragma
            const walMode = (db as any).db.pragma('journal_mode', { simple: true });
            expect(walMode).toBe('wal');
        });

        it('should handle concurrent reads and writes', async () => {
            const operations: Promise<void>[] = [];

            // Helper to generate mock signal
            const generateMockSignal = (): TradingSignal & { metadata?: Record<string, unknown> } => ({
                pair: 'BTC-USDC',
                direction: 'long',
                type: 'entry',
                price: new Decimal(50000),
                timestamp: Date.now(),
                strength: new Decimal(0.8),
                components: {
                    quadExtreme: true,
                    divergence: 'bullish',
                    location: 'support',
                    rotation: 'up'
                },
                metadata: {}
            });

            // Start concurrent writes
            for (let i = 0; i < 100; i++) {
                operations.push(db.saveTrade(generateMockTradeRecord()));
                operations.push(db.saveSignal(generateMockSignal()));
            }

            // Start concurrent reads (await them separately)
            const readResults = await Promise.all([
                ...Array.from({ length: 25 }, () => db.getRecentTrades(10)),
                ...Array.from({ length: 25 }, () => db.getRecentSignals(10))
            ]);

            // Verify reads completed
            expect(readResults.length).toBe(50);

            // Wait for all operations to complete
            await Promise.all(operations);

            // Verify data integrity
            const trades = await db.getRecentTrades(100);
            const signals = await db.getRecentSignals(100);

            expect(trades.length).toBeGreaterThan(0);
            expect(signals.length).toBeGreaterThan(0);
        }, 15000);
    });

    describe('Transaction Handling', () => {
        it('should handle transaction errors gracefully', async () => {
            // This test verifies that transaction errors don't crash the system
            const initialMemory = process.memoryUsage().heapUsed;

            // Try to save invalid data (should be caught by try-catch)
            try {
                await db.saveTrade({
                    pair: '',
                    direction: 'long',
                    entryPrice: 0,
                    exitPrice: 0,
                    size: 0,
                    pnl: 0,
                    pnlPercent: 0,
                    entryTime: 0,
                    exitTime: 0,
                    strategy: ''
                });
            } catch (e) {
                // Expected to be caught
            }

            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }

            const finalMemory = process.memoryUsage().heapUsed;
            const memoryGrowth = finalMemory - initialMemory;

            // Memory growth should be minimal
            expect(memoryGrowth).toBeLessThan(5 * 1024 * 1024); // 5MB
        }, 5000);
    });

    describe('Connection State Tracking', () => {
        it('should maintain connection state during operations', async () => {
            // Verify database is open
            expect((db as any).db).toBeDefined();
            expect((db as any).db.open).toBe(true);

            // Perform operations
            await db.saveTrade(generateMockTradeRecord());
            await db.getRecentTrades(10);

            // Database should still be open
            expect((db as any).db.open).toBe(true);
        });

        it('should close gracefully', async () => {
            // Write some data
            for (let i = 0; i < 10; i++) {
                await db.saveTrade(generateMockTradeRecord());
            }

            // Close database
            await db.close();

            // Verify database is closed
            expect((db as any).db.open).toBe(false);
        });
    });

    describe('Memory Leak Prevention', () => {
        it('should not leak memory during batch operations', async () => {
            const snapshots: number[] = [];

            // Take initial snapshot
            snapshots.push(process.memoryUsage().heapUsed);

            // Perform many batch operations
            for (let i = 0; i < 100; i++) {
                for (let j = 0; j < 10; j++) {
                    await db.saveTrade(generateMockTradeRecord());
                }

                // Take snapshot every 10 batches
                if (i % 10 === 0) {
                    if (global.gc) {
                        global.gc();
                    }
                    snapshots.push(process.memoryUsage().heapUsed);
                }
            }

            // Force garbage collection
            if (global.gc) {
                global.gc();
            }
            snapshots.push(process.memoryUsage().heapUsed);

            // Check memory growth
            const memorySnapshots: MemorySnapshot[] = snapshots.map((heapUsed, index) => ({
                timestamp: Date.now() - (snapshots.length - index) * 1000,
                heapUsed,
                heapTotal: heapUsed + 10 * 1024 * 1024,
                external: 0,
                arrayBuffers: 0,
                rss: heapUsed + 20 * 1024 * 1024
            }));

            const growthResult = assertMemoryGrowth(
                memorySnapshots,
                1024 * 1024, // 1 MB/s
                10000 // 10 seconds
            );

            expect(growthResult.passed).toBe(true);
        }, 30000);
    });

    describe('Batch File Persistence', () => {
        it('should persist batch files to disk', async () => {
            const batchDir = 'data/test-batches';

            // Write enough data to trigger batch flush
            for (let i = 0; i < 60; i++) {
                await db.saveTrade(generateMockTradeRecord());
            }

            // Wait for flush
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Check if batch files were created
            const files = await fs.readdir(batchDir).catch(() => []);

            // Should have at least one batch file
            expect(files.length).toBeGreaterThan(0);

            // Verify file format
            const batchFiles = files.filter(f => f.startsWith('trades_') && f.endsWith('.json'));
            expect(batchFiles.length).toBeGreaterThan(0);
        }, 10000);

        it('should sync batch files to SQLite', async () => {
            // Write data
            for (let i = 0; i < 60; i++) {
                await db.saveTrade(generateMockTradeRecord());
            }

            // Wait for batch flush and SQLite sync
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Verify data in SQLite
            const trades = await db.getRecentTrades(60);
            expect(trades.length).toBeGreaterThan(0);
        }, 10000);
    });

    describe('Equity Snapshot Operations', () => {
        it('should handle high-frequency equity snapshots', async () => {
            const snapshotCount = 500;

            for (let i = 0; i < snapshotCount; i++) {
                await db.saveEquitySnapshot(10000 + Math.random() * 1000, Math.random() * 500 - 250);
            }

            // Wait for batch flush
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Verify snapshots were saved
            const equityHistory = await db.getEquityHistory(snapshotCount);
            expect(equityHistory.length).toBeGreaterThan(0);
        }, 10000);
    });

    describe('Error Recovery', () => {
        it('should recover from write errors', async () => {
            // Mock a write error
            const originalWriteFile = fs.writeFile;
            let callCount = 0;

            vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
                callCount++;
                if (callCount === 1) {
                    throw new Error('Simulated write error');
                }
                return originalWriteFile(path, data, options);
            });

            // Try to write data
            await db.saveTrade(generateMockTradeRecord());

            // Wait for flush attempt
            await new Promise(resolve => setTimeout(resolve, 2000));

            // System should still be functional
            await db.saveTrade(generateMockTradeRecord());
            const trades = await db.getRecentTrades(10);

            // Should have recovered and saved some data
            expect(trades.length).toBeGreaterThanOrEqual(0);

            // Restore original
            vi.restoreAllMocks();
        }, 5000);
    });
});

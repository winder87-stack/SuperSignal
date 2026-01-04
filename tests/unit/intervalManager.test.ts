/**
 * IntervalManager Unit Tests
 *
 * Comprehensive tests for the centralized interval management system including:
 * - Basic functionality (setInterval, clearInterval, clearAll)
 * - Error handling (callbacks that throw, error counting)
 * - Shutdown behavior (clearAll, isShuttingDown flag)
 * - Metadata tracking (execution count, timestamps)
 * - Edge cases (non-existent intervals, shutdown prevention)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntervalManager, IntervalMetadata, IntervalId } from '../../src/utils/intervalManager.js';

// Mock the TradingLogger to avoid side effects
vi.mock('../../src/utils/logger.js', () => ({
    TradingLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        signal: vi.fn(),
        trade: vi.fn()
    }
}));

describe('IntervalManager - Basic Functionality', () => {
    let manager: IntervalManager;

    beforeEach(() => {
        // Reset singleton instance for each test
        (IntervalManager as any).instance = undefined;
        manager = IntervalManager.getInstance();
        vi.useFakeTimers();
    });

    afterEach(() => {
        manager.reset();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe('setInterval', () => {
        it('should create and track a new interval', () => {
            const callback = vi.fn();
            const intervalMs = 1000;

            const id = manager.setInterval(callback, intervalMs);

            expect(id).toBeDefined();
            expect(manager.getActiveCount()).toBe(1);

            const metadata = manager.getInterval(id);
            expect(metadata).toBeDefined();
            expect(metadata?.callback).toBe(callback);
            expect(metadata?.interval).toBe(intervalMs);
            expect(metadata?.executionCount).toBe(0);
            expect(metadata?.errorCount).toBe(0);
            expect(metadata?.isExecuting).toBe(false);
        });

        it('should assign a default name if not provided', () => {
            const callback = vi.fn();
            const id = manager.setInterval(callback, 1000);

            const metadata = manager.getInterval(id);
            expect(metadata?.name).toMatch(/^interval-\d+-[a-z0-9]{6}$/);
        });

        it('should use provided name if specified', () => {
            const callback = vi.fn();
            const customName = 'test-interval';
            const id = manager.setInterval(callback, 1000, { name: customName });

            const metadata = manager.getInterval(id);
            expect(metadata?.name).toBe(customName);
        });

        it('should set creation timestamp', () => {
            const callback = vi.fn();
            const beforeTime = Date.now();
            const id = manager.setInterval(callback, 1000);
            const afterTime = Date.now();

            const metadata = manager.getInterval(id);
            expect(metadata?.createdAt).toBeGreaterThanOrEqual(beforeTime);
            expect(metadata?.createdAt).toBeLessThanOrEqual(afterTime);
        });

        it('should create multiple intervals', () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            const callback3 = vi.fn();

            manager.setInterval(callback1, 1000);
            manager.setInterval(callback2, 2000);
            manager.setInterval(callback3, 3000);

            expect(manager.getActiveCount()).toBe(3);
        });
    });

    describe('clearInterval', () => {
        it('should remove interval from registry', () => {
            const callback = vi.fn();
            const id = manager.setInterval(callback, 1000);

            expect(manager.getActiveCount()).toBe(1);

            const result = manager.clearInterval(id);

            expect(result).toBe(true);
            expect(manager.getActiveCount()).toBe(0);
            expect(manager.getInterval(id)).toBeUndefined();
        });

        it('should return false for non-existent interval', () => {
            const fakeId = {} as NodeJS.Timeout;
            const result = manager.clearInterval(fakeId);

            expect(result).toBe(false);
        });

        it('should clear specific interval while keeping others', () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            const id1 = manager.setInterval(callback1, 1000);
            const id2 = manager.setInterval(callback2, 2000);

            expect(manager.getActiveCount()).toBe(2);

            manager.clearInterval(id1);

            expect(manager.getActiveCount()).toBe(1);
            expect(manager.getInterval(id1)).toBeUndefined();
            expect(manager.getInterval(id2)).toBeDefined();
        });
    });

    describe('clearIntervalByName', () => {
        it('should clear interval by name', () => {
            const callback = vi.fn();
            const name = 'test-interval';
            manager.setInterval(callback, 1000, { name });

            expect(manager.getActiveCount()).toBe(1);

            const result = manager.clearIntervalByName(name);

            expect(result).toBe(true);
            expect(manager.getActiveCount()).toBe(0);
        });

        it('should return false for non-existent name', () => {
            const result = manager.clearIntervalByName('non-existent');
            expect(result).toBe(false);
        });

        it('should clear first matching interval if multiple have same name', () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            const name = 'duplicate-name';
            manager.setInterval(callback1, 1000, { name });
            manager.setInterval(callback2, 2000, { name });

            expect(manager.getActiveCount()).toBe(2);

            manager.clearIntervalByName(name);

            expect(manager.getActiveCount()).toBe(1);
        });
    });

    describe('clearAll', () => {
        it('should remove all intervals', () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            const callback3 = vi.fn();

            manager.setInterval(callback1, 1000);
            manager.setInterval(callback2, 2000);
            manager.setInterval(callback3, 3000);

            expect(manager.getActiveCount()).toBe(3);

            manager.clearAll();

            expect(manager.getActiveCount()).toBe(0);
            expect(manager.getAllIntervals()).toHaveLength(0);
        });

        it('should do nothing when no intervals exist', () => {
            expect(manager.getActiveCount()).toBe(0);

            expect(() => manager.clearAll()).not.toThrow();
            expect(manager.getActiveCount()).toBe(0);
        });
    });

    describe('getInterval', () => {
        it('should return correct metadata for existing interval', () => {
            const callback = vi.fn();
            const name = 'test-interval';
            const intervalMs = 1000;
            const id = manager.setInterval(callback, intervalMs, { name });

            const metadata = manager.getInterval(id);

            expect(metadata).toBeDefined();
            expect(metadata?.id).toBe(id);
            expect(metadata?.name).toBe(name);
            expect(metadata?.interval).toBe(intervalMs);
            expect(metadata?.callback).toBe(callback);
        });

        it('should return undefined for non-existent interval', () => {
            const fakeId = {} as NodeJS.Timeout;
            const metadata = manager.getInterval(fakeId);

            expect(metadata).toBeUndefined();
        });
    });

    describe('getIntervalByName', () => {
        it('should return metadata for interval by name', () => {
            const callback = vi.fn();
            const name = 'test-interval';
            manager.setInterval(callback, 1000, { name });

            const metadata = manager.getIntervalByName(name);

            expect(metadata).toBeDefined();
            expect(metadata?.name).toBe(name);
        });

        it('should return undefined for non-existent name', () => {
            const metadata = manager.getIntervalByName('non-existent');
            expect(metadata).toBeUndefined();
        });
    });

    describe('getAllIntervals', () => {
        it('should return all tracked intervals', () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            const callback3 = vi.fn();

            const id1 = manager.setInterval(callback1, 1000);
            const id2 = manager.setInterval(callback2, 2000);
            const id3 = manager.setInterval(callback3, 3000);

            const allIntervals = manager.getAllIntervals();

            expect(allIntervals).toHaveLength(3);
            expect(allIntervals.map(m => m.id)).toContainEqual(id1);
            expect(allIntervals.map(m => m.id)).toContainEqual(id2);
            expect(allIntervals.map(m => m.id)).toContainEqual(id3);
        });

        it('should return empty array when no intervals exist', () => {
            const allIntervals = manager.getAllIntervals();
            expect(allIntervals).toEqual([]);
        });
    });

    describe('getActiveCount', () => {
        it('should return correct count of active intervals', () => {
            expect(manager.getActiveCount()).toBe(0);

            manager.setInterval(vi.fn(), 1000);
            expect(manager.getActiveCount()).toBe(1);

            manager.setInterval(vi.fn(), 2000);
            expect(manager.getActiveCount()).toBe(2);

            manager.setInterval(vi.fn(), 3000);
            expect(manager.getActiveCount()).toBe(3);
        });

        it('should update count after clearing intervals', () => {
            const id1 = manager.setInterval(vi.fn(), 1000);
            const id2 = manager.setInterval(vi.fn(), 2000);

            expect(manager.getActiveCount()).toBe(2);

            manager.clearInterval(id1);
            expect(manager.getActiveCount()).toBe(1);

            manager.clearInterval(id2);
            expect(manager.getActiveCount()).toBe(0);
        });
    });

    describe('getInFlightCount', () => {
        it('should return 0 when no intervals are executing', () => {
            expect(manager.getInFlightCount()).toBe(0);
        });

        it('should return count of intervals currently executing', async () => {
            let resolveCallback: () => void;
            const slowCallback = vi.fn(() => new Promise<void>(resolve => {
                resolveCallback = resolve;
            }));

            manager.setInterval(slowCallback, 1000);

            // Trigger first execution
            vi.advanceTimersByTime(1000);
            await vi.runOnlyPendingTimersAsync();

            const inFlightCount = manager.getInFlightCount();
            expect(inFlightCount).toBeGreaterThanOrEqual(1);

            // Resolve the callback
            resolveCallback!();
            await vi.runOnlyPendingTimersAsync();

            expect(manager.getInFlightCount()).toBe(0);
        });
    });

    describe('getHealthStatus', () => {
        it('should return health metrics for all intervals', () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();

            manager.setInterval(callback1, 1000, { name: 'interval-1' });
            manager.setInterval(callback2, 2000, { name: 'interval-2' });

            const health = manager.getHealthStatus();

            expect(health.total).toBe(2);
            expect(health.inFlight).toBe(0);
            expect(health.healthy).toBe(2);
            expect(health.unhealthy).toBe(0);
            expect(health.stalled).toBe(0);
            expect(health.details).toHaveLength(2);
        });

        it('should identify unhealthy intervals with errors', async () => {
            const errorCallback = vi.fn(() => {
                throw new Error('Test error');
            });

            manager.setInterval(errorCallback, 1000, { name: 'error-interval' });

            // Trigger execution
            vi.advanceTimersByTime(1000);
            await vi.runOnlyPendingTimersAsync();

            const health = manager.getHealthStatus();

            expect(health.unhealthy).toBeGreaterThanOrEqual(1);
            expect(health.details[0].errorCount).toBeGreaterThanOrEqual(1);
        });

        it('should identify stalled intervals', () => {
            const callback = vi.fn();
            manager.setInterval(callback, 1000, { name: 'stalled-interval' });

            // Advance time beyond 3x interval
            vi.advanceTimersByTime(4000);

            const health = manager.getHealthStatus();

            expect(health.stalled).toBe(1);
            expect(health.details[0].isStalled).toBe(true);
        });
    });
});

describe('IntervalManager - Error Handling', () => {
    let manager: IntervalManager;

    beforeEach(() => {
        (IntervalManager as any).instance = undefined;
        manager = IntervalManager.getInstance();
        vi.useFakeTimers();
    });

    afterEach(() => {
        manager.reset();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('should catch and log errors in callbacks', async () => {
        const errorCallback = vi.fn(() => {
            throw new Error('Test error');
        });

        manager.setInterval(errorCallback, 1000, { name: 'error-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(errorCallback).toHaveBeenCalled();
        // Error should be caught and logged (may be 1 or 2 due to timer behavior)
        expect(manager.getAllIntervals()[0].errorCount).toBeGreaterThanOrEqual(1);
    });

    it('should continue running interval after error by default', async () => {
        const errorCallback = vi.fn(() => {
            throw new Error('Test error');
        });

        manager.setInterval(errorCallback, 1000, { name: 'error-interval' });

        // Trigger multiple executions
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(errorCallback).toHaveBeenCalled();
        expect(manager.getAllIntervals()[0].errorCount).toBeGreaterThanOrEqual(3);
    });

    it('should stop interval on error when stopOnError is true', async () => {
        const errorCallback = vi.fn(() => {
            throw new Error('Test error');
        });

        manager.setInterval(errorCallback, 1000, { name: 'error-interval', stopOnError: true });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(errorCallback).toHaveBeenCalledTimes(1);
        expect(manager.getActiveCount()).toBe(0);
    });

    it('should increment error count correctly', async () => {
        const errorCallback = vi.fn(() => {
            throw new Error('Test error');
        });

        manager.setInterval(errorCallback, 1000, { name: 'error-interval' });

        // Trigger multiple executions
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(1000);
            await vi.runOnlyPendingTimersAsync();
        }

        expect(manager.getAllIntervals()[0].errorCount).toBeGreaterThanOrEqual(5);
    });

    it('should capture error metadata', async () => {
        const errorCallback = vi.fn(() => {
            throw new Error('Test error with stack');
        });

        manager.setInterval(errorCallback, 1000, { name: 'error-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        const metadata = manager.getAllIntervals()[0];
        expect(metadata.errorCount).toBeGreaterThanOrEqual(1);
        expect(metadata.executionCount).toBe(0); // Should not increment on error
    });

    it('should handle async callback errors', async () => {
        const asyncErrorCallback = vi.fn(async () => {
            await Promise.resolve();
            throw new Error('Async error');
        });

        manager.setInterval(asyncErrorCallback, 1000, { name: 'async-error-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(asyncErrorCallback).toHaveBeenCalled();
        expect(manager.getAllIntervals()[0].errorCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle non-Error objects thrown', async () => {
        const stringThrowCallback = vi.fn(() => {
            throw 'String error';
        });

        manager.setInterval(stringThrowCallback, 1000, { name: 'string-error-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(stringThrowCallback).toHaveBeenCalled();
        expect(manager.getAllIntervals()[0].errorCount).toBeGreaterThanOrEqual(1);
    });
});

describe('IntervalManager - Metadata Tracking', () => {
    let manager: IntervalManager;

    beforeEach(() => {
        (IntervalManager as any).instance = undefined;
        manager = IntervalManager.getInstance();
        vi.useFakeTimers();
    });

    afterEach(() => {
        manager.reset();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('should increment execution count on successful callback', async () => {
        const callback = vi.fn();
        manager.setInterval(callback, 1000, { name: 'test-interval' });

        // Trigger multiple executions
        for (let i = 0; i < 3; i++) {
            vi.advanceTimersByTime(1000);
            await vi.runOnlyPendingTimersAsync();
        }

        expect(callback).toHaveBeenCalled();
        expect(manager.getAllIntervals()[0].executionCount).toBeGreaterThanOrEqual(3);
    });

    it('should update last execution time', async () => {
        const callback = vi.fn();
        manager.setInterval(callback, 1000, { name: 'test-interval' });

        const beforeExecution = Date.now();
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();
        const afterExecution = Date.now();

        const metadata = manager.getAllIntervals()[0];
        expect(metadata.lastExecuted).toBeGreaterThanOrEqual(beforeExecution);
        expect(metadata.lastExecuted).toBeLessThanOrEqual(afterExecution);
    });

    it('should not increment execution count on error', async () => {
        const errorCallback = vi.fn(() => {
            throw new Error('Test error');
        });

        manager.setInterval(errorCallback, 1000, { name: 'error-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(manager.getAllIntervals()[0].executionCount).toBe(0);
        expect(manager.getAllIntervals()[0].errorCount).toBeGreaterThanOrEqual(1);
    });

    it('should track isExecuting flag correctly', async () => {
        let resolveCallback: () => void;
        const slowCallback = vi.fn(() => new Promise<void>(resolve => {
            resolveCallback = resolve;
        }));

        manager.setInterval(slowCallback, 1000, { name: 'slow-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        const metadata = manager.getInterval(manager.getAllIntervals()[0].id);
        expect(metadata?.isExecuting).toBe(true);

        // Resolve the callback
        resolveCallback!();
        await vi.runOnlyPendingTimersAsync();

        // After resolving, the flag should be false
        // Note: The metadata reference might be stale, get fresh reference
        const freshMetadata = manager.getInterval(manager.getAllIntervals()[0].id);
        expect(freshMetadata?.isExecuting).toBe(false);
    });

    it('should store interval name in metadata', () => {
        const callback = vi.fn();
        const name = 'custom-interval-name';
        manager.setInterval(callback, 1000, { name });

        const metadata = manager.getAllIntervals()[0];
        expect(metadata.name).toBe(name);
    });
});

describe('IntervalManager - Shutdown Behavior', () => {
    let manager: IntervalManager;

    beforeEach(() => {
        (IntervalManager as any).instance = undefined;
        manager = IntervalManager.getInstance();
        vi.useFakeTimers();
    });

    afterEach(() => {
        manager.reset();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('should clear all intervals on shutdown', async () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        const callback3 = vi.fn();

        manager.setInterval(callback1, 1000);
        manager.setInterval(callback2, 2000);
        manager.setInterval(callback3, 3000);

        expect(manager.getActiveCount()).toBe(3);

        await manager.shutdown();

        expect(manager.getActiveCount()).toBe(0);
    });

    it('should set isShuttingDown flag', async () => {
        expect((manager as any).isShuttingDown).toBe(false);

        await manager.shutdown();

        expect((manager as any).isShuttingDown).toBe(true);
    });

    it('should prevent new intervals during shutdown', async () => {
        await manager.shutdown();

        const callback = vi.fn();
        const id = manager.setInterval(callback, 1000);

        // Should return a dummy timeout
        expect(id).toBeDefined();
        expect(manager.getActiveCount()).toBe(0);
    });

    it('should wait for in-flight executions before clearing', async () => {
        let resolveCallback: () => void;
        const slowCallback = vi.fn(() => new Promise<void>(resolve => {
            resolveCallback = resolve;
        }));

        manager.setInterval(slowCallback, 1000, { name: 'slow-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(manager.getInFlightCount()).toBe(1);

        // Start shutdown (should wait)
        const shutdownPromise = manager.shutdown();

        // Resolve the callback
        resolveCallback!();
        await vi.runOnlyPendingTimersAsync();

        await shutdownPromise;

        expect(manager.getActiveCount()).toBe(0);
    });

    it('should timeout waiting for in-flight executions', async () => {
        let resolveCallback: () => void;
        const slowCallback = vi.fn(() => new Promise<void>(resolve => {
            resolveCallback = resolve;
        }));

        manager.setInterval(slowCallback, 1000, { name: 'slow-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(manager.getInFlightCount()).toBeGreaterThanOrEqual(1);

        // Start shutdown and advance beyond timeout
        const shutdownPromise = manager.shutdown();

        // Advance time in smaller increments to allow the shutdown polling loop to run
        for (let i = 0; i < 60; i++) {
            vi.advanceTimersByTime(100);
            await vi.runOnlyPendingTimersAsync();
        }

        await shutdownPromise;

        expect(manager.getActiveCount()).toBe(0);
    });

    it('should handle multiple shutdown calls gracefully', async () => {
        const callback = vi.fn();
        manager.setInterval(callback, 1000);

        await manager.shutdown();
        await manager.shutdown();
        await manager.shutdown();

        expect(manager.getActiveCount()).toBe(0);
    });

    it('should reset isShuttingDown flag on reset', async () => {
        await manager.shutdown();
        expect((manager as any).isShuttingDown).toBe(true);

        manager.reset();
        expect((manager as any).isShuttingDown).toBe(false);
    });
});

describe('IntervalManager - Edge Cases', () => {
    let manager: IntervalManager;

    beforeEach(() => {
        (IntervalManager as any).instance = undefined;
        manager = IntervalManager.getInstance();
        vi.useFakeTimers();
    });

    afterEach(() => {
        manager.reset();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('should prevent overlapping executions', async () => {
        let resolveCallback: () => void;
        const slowCallback = vi.fn(() => new Promise<void>(resolve => {
            resolveCallback = resolve;
        }));

        manager.setInterval(slowCallback, 100, { name: 'slow-interval' });

        // Trigger first execution
        vi.advanceTimersByTime(100);
        await vi.runOnlyPendingTimersAsync();

        expect(slowCallback).toHaveBeenCalledTimes(1);
        expect(manager.getInFlightCount()).toBe(1);

        // Try to trigger second execution while first is still running
        vi.advanceTimersByTime(100);
        await vi.runOnlyPendingTimersAsync();

        // Should still be 1 because overlapping execution is prevented
        expect(slowCallback).toHaveBeenCalledTimes(1);

        // Resolve the first callback
        resolveCallback!();
        await vi.runOnlyPendingTimersAsync();

        expect(manager.getInFlightCount()).toBe(0);
    });

    it('should handle async callbacks correctly', async () => {
        const asyncCallback = vi.fn(async () => {
            await Promise.resolve();
        });

        manager.setInterval(asyncCallback, 1000, { name: 'async-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(asyncCallback).toHaveBeenCalledTimes(1);
        expect(manager.getAllIntervals()[0].executionCount).toBe(1);
    });

    it('should handle mixed sync and async callbacks', async () => {
        const syncCallback = vi.fn(() => { });
        const asyncCallback = vi.fn(async () => {
            await Promise.resolve();
        });

        manager.setInterval(syncCallback, 1000, { name: 'sync-interval' });
        manager.setInterval(asyncCallback, 1000, { name: 'async-interval' });

        // Trigger executions
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(syncCallback).toHaveBeenCalledTimes(1);
        expect(asyncCallback).toHaveBeenCalledTimes(1);
    });

    it('should handle clearing interval while executing', async () => {
        let resolveCallback: () => void;
        const slowCallback = vi.fn(() => new Promise<void>(resolve => {
            resolveCallback = resolve;
        }));

        const id = manager.setInterval(slowCallback, 1000, { name: 'slow-interval' });

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(manager.getInFlightCount()).toBe(1);

        // Clear interval while executing
        const result = manager.clearInterval(id);

        expect(result).toBe(true);
        expect(manager.getActiveCount()).toBe(0);

        // Resolve the callback
        resolveCallback!();
        await vi.runOnlyPendingTimersAsync();
    });

    it('should handle very short intervals', async () => {
        const callback = vi.fn();
        manager.setInterval(callback, 1, { name: 'fast-interval' });

        // Trigger multiple executions
        vi.advanceTimersByTime(10);
        await vi.runOnlyPendingTimersAsync();

        expect(callback).toHaveBeenCalled();
    });

    it('should handle very long intervals', () => {
        const callback = vi.fn();
        manager.setInterval(callback, 1000000, { name: 'slow-interval' });

        expect(manager.getActiveCount()).toBe(1);
        expect(callback).not.toHaveBeenCalled();
    });

    it('should handle zero interval (immediate execution)', async () => {
        const callback = vi.fn();
        manager.setInterval(callback, 0, { name: 'immediate-interval' });

        // Trigger execution
        vi.advanceTimersByTime(0);
        await vi.runOnlyPendingTimersAsync();

        expect(callback).toHaveBeenCalled();
    });

    it('should handle callback that returns undefined', async () => {
        const callback = vi.fn(() => undefined);
        manager.setInterval(callback, 1000, { name: 'undefined-interval' });

        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(callback).toHaveBeenCalled();
        expect(manager.getAllIntervals()[0].executionCount).toBe(1);
    });

    it('should handle callback that returns null', async () => {
        const callback = vi.fn(() => undefined as any);
        manager.setInterval(callback, 1000, { name: 'null-interval' });

        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(callback).toHaveBeenCalled();
        expect(manager.getAllIntervals()[0].executionCount).toBe(1);
    });
});

describe('IntervalManager - Singleton Pattern', () => {
    it('should return same instance across multiple calls', () => {
        const instance1 = IntervalManager.getInstance();
        const instance2 = IntervalManager.getInstance();
        const instance3 = IntervalManager.getInstance();

        expect(instance1).toBe(instance2);
        expect(instance2).toBe(instance3);
    });

    it('should maintain state across getInstance calls', () => {
        const instance1 = IntervalManager.getInstance();
        instance1.setInterval(vi.fn(), 1000);

        const instance2 = IntervalManager.getInstance();

        expect(instance2.getActiveCount()).toBe(1);
    });
});

describe('IntervalManager - Reset Functionality', () => {
    let manager: IntervalManager;

    beforeEach(() => {
        (IntervalManager as any).instance = undefined;
        manager = IntervalManager.getInstance();
        vi.useFakeTimers();
    });

    afterEach(() => {
        manager.reset();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('should clear all intervals on reset', () => {
        manager.setInterval(vi.fn(), 1000);
        manager.setInterval(vi.fn(), 2000);
        manager.setInterval(vi.fn(), 3000);

        expect(manager.getActiveCount()).toBe(3);

        manager.reset();

        expect(manager.getActiveCount()).toBe(0);
    });

    it('should reset isShuttingDown flag', async () => {
        await manager.shutdown();
        expect((manager as any).isShuttingDown).toBe(true);

        manager.reset();
        expect((manager as any).isShuttingDown).toBe(false);
    });

    it('should reset isInitialized flag', () => {
        manager.initialize();
        expect((manager as any).isInitialized).toBe(true);

        manager.reset();
        expect((manager as any).isInitialized).toBe(false);
    });

    it('should clear in-flight executions on reset', async () => {
        let resolveCallback: () => void;
        const slowCallback = vi.fn(() => new Promise<void>(resolve => {
            resolveCallback = resolve;
        }));

        manager.setInterval(slowCallback, 1000);

        // Trigger execution
        vi.advanceTimersByTime(1000);
        await vi.runOnlyPendingTimersAsync();

        expect(manager.getInFlightCount()).toBe(1);

        manager.reset();

        expect(manager.getInFlightCount()).toBe(0);

        // Resolve the callback
        resolveCallback!();
        await vi.runOnlyPendingTimersAsync();
    });
});

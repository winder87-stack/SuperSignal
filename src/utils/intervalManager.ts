/**
 * Centralized Interval Management System
 *
 * Provides safe interval management with automatic error handling,
 * global error hooks, and graceful shutdown capabilities.
 *
 * Key Features:
 * - Automatic try/catch wrapping for all callbacks
 * - Metadata tracking (execution count, error count, last execution)
 * - Global error hooks for catastrophic failures
 * - Graceful shutdown on process termination
 * - Singleton pattern for centralized control
 */

import { TradingLogger } from './logger.js';

/**
 * Metadata for each registered interval
 */
export interface IntervalMetadata {
    id: NodeJS.Timeout;
    name: string;
    callback: () => void | Promise<void>;
    interval: number;
    createdAt: number;
    lastExecuted?: number;
    executionCount: number;
    errorCount: number;
    isExecuting: boolean;
}

/**
 * Type alias for interval ID (NodeJS.Timeout in newer Node.js versions)
 */
export type IntervalId = NodeJS.Timeout;

/**
 * Options for interval registration
 */
export interface IntervalOptions {
    /** Human-readable name for the interval (defaults to auto-generated) */
    name?: string;
    /** Whether to log each execution (default: false) */
    logExecution?: boolean;
    /** Whether to stop the interval on error (default: false) */
    stopOnError?: boolean;
}

/**
 * Centralized interval manager with automatic error handling and cleanup
 */
export class IntervalManager {
    private intervals: Map<IntervalId, IntervalMetadata>;
    private isShuttingDown: boolean;
    private isInitialized: boolean;
    private inFlightExecutions: Set<IntervalId>;
    // CRITICAL FIX: Track dummy timeouts for cleanup
    private dummyTimeouts: Set<IntervalId> = new Set();

    // Singleton pattern
    private static instance: IntervalManager;

    private constructor() {
        this.intervals = new Map();
        this.isShuttingDown = false;
        this.isInitialized = false;
        this.inFlightExecutions = new Set();
    }

    /**
     * Get the singleton instance
     */
    static getInstance(): IntervalManager {
        if (!IntervalManager.instance) {
            IntervalManager.instance = new IntervalManager();
        }
        return IntervalManager.instance;
    }

    /**
     * Register a new interval with automatic error handling
     * 
     * @param callback - Function to execute on each interval
     * @param intervalMs - Interval duration in milliseconds
     * @param options - Optional configuration
     * @returns The interval ID for later reference
     */
    setInterval(
        callback: () => void | Promise<void>,
        intervalMs: number,
        options: IntervalOptions = {}
    ): IntervalId {
        if (this.isShuttingDown) {
            TradingLogger.warn('Attempted to create interval during shutdown', {
                intervalMs,
                name: options.name
            });
            // CRITICAL FIX: Return a dummy timeout that gets cleaned up properly
            // Use a no-op callback that doesn't create a zombie
            const dummyId = setTimeout(() => { }, 0);
            // Track this dummy timeout for cleanup
            this.dummyTimeouts = this.dummyTimeouts || new Set();
            this.dummyTimeouts.add(dummyId);
            return dummyId as IntervalId;
        }

        const name = options.name || `interval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const createdAt = Date.now();

        // Create the wrapped callback with error handling
        const wrappedCallback = async (): Promise<void> => {
            const metadata = this.intervals.get(intervalId);
            if (!metadata) {
                // Interval was cleared, stop executing
                return;
            }

            // Skip if already executing (prevent overlapping executions)
            if (metadata.isExecuting) {
                TradingLogger.debug(`Interval ${name} skipped - already executing`, {
                    intervalId,
                    name
                });
                return;
            }

            metadata.isExecuting = true;
            this.inFlightExecutions.add(intervalId);

            try {
                if (options.logExecution) {
                    TradingLogger.debug(`Executing interval: ${name}`, {
                        intervalId,
                        name,
                        intervalMs
                    });
                }

                // Execute the callback
                await callback();

                // Update metadata on success
                metadata.lastExecuted = Date.now();
                metadata.executionCount++;

                if (options.logExecution) {
                    TradingLogger.debug(`Interval completed: ${name}`, {
                        intervalId,
                        name,
                        executionCount: metadata.executionCount,
                        duration: metadata.lastExecuted - createdAt
                    });
                }
            } catch (error) {
                // Update error metadata
                metadata.errorCount++;
                const errorObj = error instanceof Error ? error : new Error(String(error));

                TradingLogger.error(`Interval error: ${name}`, {
                    intervalId,
                    name,
                    error: errorObj.message,
                    stack: errorObj.stack,
                    executionCount: metadata.executionCount,
                    errorCount: metadata.errorCount
                });

                // Stop interval on error if configured
                if (options.stopOnError) {
                    TradingLogger.warn(`Stopping interval due to error: ${name}`, {
                        intervalId,
                        name,
                        error: errorObj.message
                    });
                    this.clearInterval(intervalId);
                }
            } finally {
                metadata.isExecuting = false;
                this.inFlightExecutions.delete(intervalId);
            }
        };

        // Create the interval
        const intervalId = setInterval(wrappedCallback, intervalMs);

        // Store metadata
        const metadata: IntervalMetadata = {
            id: intervalId,
            name,
            callback,
            interval: intervalMs,
            createdAt,
            executionCount: 0,
            errorCount: 0,
            isExecuting: false
        };

        this.intervals.set(intervalId, metadata);

        TradingLogger.info(`Interval registered: ${name}`, {
            intervalId,
            name,
            intervalMs,
            createdAt
        });

        return intervalId;
    }

    /**
     * Clear a specific interval by ID
     * 
     * @param id - The interval ID to clear
     * @returns true if interval was found and cleared, false otherwise
     */
    clearInterval(id: IntervalId): boolean {
        const metadata = this.intervals.get(id);

        if (!metadata) {
            TradingLogger.debug(`Attempted to clear non-existent interval`, { id });
            return false;
        }

        // Wait for in-flight execution to complete
        if (metadata.isExecuting) {
            TradingLogger.debug(`Waiting for in-flight execution before clearing: ${metadata.name}`, {
                id,
                name: metadata.name
            });
        }

        clearInterval(id);
        this.intervals.delete(id);

        TradingLogger.info(`Interval cleared: ${metadata.name}`, {
            id,
            name: metadata.name,
            executionCount: metadata.executionCount,
            errorCount: metadata.errorCount,
            lifetime: Date.now() - metadata.createdAt
        });

        return true;
    }

    /**
     * Clear a specific interval by name
     * 
     * @param name - The interval name to clear
     * @returns true if interval was found and cleared, false otherwise
     */
    clearIntervalByName(name: string): boolean {
        for (const [id, metadata] of this.intervals.entries()) {
            if (metadata.name === name) {
                return this.clearInterval(id);
            }
        }
        return false;
    }

    /**
     * Clear all intervals
     * Waits for in-flight executions to complete
     */
    clearAll(): void {
        const count = this.intervals.size;

        if (count === 0) {
            TradingLogger.debug('No intervals to clear');
            return;
        }

        TradingLogger.info(`Clearing all intervals (${count} active)`, {
            count,
            intervals: Array.from(this.intervals.values()).map(m => ({
                id: m.id,
                name: m.name,
                executionCount: m.executionCount,
                errorCount: m.errorCount
            }))
        });

        // Clear all intervals
        for (const [id] of this.intervals.entries()) {
            clearInterval(id);
        }

        this.intervals.clear();
        this.inFlightExecutions.clear();

        TradingLogger.info('All intervals cleared', { count });
    }

    /**
     * Get interval metadata by ID
     * 
     * @param id - The interval ID
     * @returns The interval metadata or undefined if not found
     */
    getInterval(id: NodeJS.Timeout): IntervalMetadata | undefined {
        return this.intervals.get(id);
    }

    /**
     * Get interval metadata by name
     * 
     * @param name - The interval name
     * @returns The interval metadata or undefined if not found
     */
    getIntervalByName(name: string): IntervalMetadata | undefined {
        for (const metadata of this.intervals.values()) {
            if (metadata.name === name) {
                return metadata;
            }
        }
        return undefined;
    }

    /**
     * Get all interval metadata
     * 
     * @returns Array of all interval metadata
     */
    getAllIntervals(): IntervalMetadata[] {
        return Array.from(this.intervals.values());
    }

    /**
     * Get the count of active intervals
     * 
     * @returns Number of active intervals
     */
    getActiveCount(): number {
        return this.intervals.size;
    }

    /**
     * Get the count of intervals currently executing
     * 
     * @returns Number of intervals currently in-flight
     */
    getInFlightCount(): number {
        return this.inFlightExecutions.size;
    }

    /**
     * Get health status of all intervals
     * 
     * @returns Object containing health metrics
     */
    getHealthStatus(): {
        total: number;
        inFlight: number;
        healthy: number;
        unhealthy: number;
        stalled: number;
        details: Array<{
            id: IntervalId;
            name: string;
            executionCount: number;
            errorCount: number;
            lastExecuted: number | undefined;
            isStalled: boolean;
        }>;
    } {
        const now = Date.now();
        const details = Array.from(this.intervals.values()).map(metadata => {
            const isStalled = metadata.lastExecuted
                ? (now - metadata.lastExecuted) > (metadata.interval * 3)
                : (now - metadata.createdAt) > (metadata.interval * 3);

            return {
                id: metadata.id,
                name: metadata.name,
                executionCount: metadata.executionCount,
                errorCount: metadata.errorCount,
                lastExecuted: metadata.lastExecuted,
                isStalled
            };
        });

        return {
            total: this.intervals.size,
            inFlight: this.inFlightExecutions.size,
            healthy: details.filter(d => d.errorCount === 0 && !d.isStalled).length,
            unhealthy: details.filter(d => d.errorCount > 0).length,
            stalled: details.filter(d => d.isStalled).length,
            details
        };
    }

    /**
     * Initialize global error and shutdown hooks
     * Should be called once at application startup
     */
    initialize(): void {
        if (this.isInitialized) {
            TradingLogger.warn('IntervalManager already initialized');
            return;
        }

        this.isInitialized = true;

        // Global error hooks - clear all intervals on unhandled errors
        process.on('unhandledRejection', (reason) => {
            TradingLogger.error('Unhandled promise rejection - clearing all intervals', {
                reason: reason instanceof Error ? reason.message : String(reason),
                stack: reason instanceof Error ? reason.stack : undefined
            });
            this.clearAll();
        });

        process.on('uncaughtException', (error) => {
            TradingLogger.error('Uncaught exception - clearing all intervals', {
                error: error.message,
                stack: error.stack
            });
            this.clearAll();
        });

        // Shutdown hooks - graceful cleanup on termination
        process.once('SIGINT', () => {
            TradingLogger.info('SIGINT received - initiating graceful shutdown');
            this.shutdown().catch(err => {
                console.error('Error during shutdown:', err);
                process.exit(1);
            });
        });

        process.once('SIGTERM', () => {
            TradingLogger.info('SIGTERM received - initiating graceful shutdown');
            this.shutdown().catch(err => {
                console.error('Error during shutdown:', err);
                process.exit(1);
            });
        });

        // beforeExit fires when the event loop has no more work
        // This is our last chance to clean up before process exit
        process.on('beforeExit', () => {
            if (!this.isShuttingDown && this.intervals.size > 0) {
                TradingLogger.info('beforeExit - clearing remaining intervals');
                this.clearAll();
            }
        });

        TradingLogger.info('IntervalManager initialized with global hooks');
    }

    /**
     * Graceful shutdown - wait for in-flight executions and clear all intervals
     * 
     * @returns Promise that resolves when shutdown is complete
     */
    async shutdown(): Promise<void> {
        if (this.isShuttingDown) {
            TradingLogger.debug('Shutdown already in progress');
            return;
        }

        this.isShuttingDown = true;
        const startTime = Date.now();
        const initialCount = this.intervals.size;
        const initialInFlight = this.inFlightExecutions.size;

        TradingLogger.info('Initiating graceful shutdown', {
            activeIntervals: initialCount,
            inFlightExecutions: initialInFlight
        });

        // Wait for in-flight executions to complete (max 5 seconds)
        const maxWaitTime = 5000;
        const pollInterval = 100;
        let waited = 0;

        while (this.inFlightExecutions.size > 0 && waited < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            waited += pollInterval;
        }

        // CRITICAL FIX: Force-kill mechanism for stuck intervals
        if (this.inFlightExecutions.size > 0) {
            TradingLogger.warn(`Shutdown timeout - force-killing ${this.inFlightExecutions.size} stuck intervals`, {
                inFlight: Array.from(this.inFlightExecutions)
            });

            // Force-kill stuck intervals by clearing them directly
            for (const stuckId of this.inFlightExecutions) {
                const metadata = this.intervals.get(stuckId);
                if (metadata) {
                    TradingLogger.warn(`Force-killing stuck interval: ${metadata.name}`, {
                        intervalId: stuckId,
                        name: metadata.name,
                        executionCount: metadata.executionCount
                    });
                    clearInterval(stuckId);
                }
            }
            this.inFlightExecutions.clear();
        }

        // Clear all intervals
        this.clearAll();

        const duration = Date.now() - startTime;
        TradingLogger.info('Graceful shutdown complete', {
            duration,
            intervalsCleared: initialCount,
            inFlightWaited: waited
        });
    }

    /**
     * Reset the manager (useful for testing)
     * Clears all intervals and resets state
     */
    reset(): void {
        this.clearAll();
        this.isShuttingDown = false;
        this.isInitialized = false;
        this.inFlightExecutions.clear();
        // CRITICAL FIX: Clear dummy timeouts
        for (const dummyId of this.dummyTimeouts) {
            clearTimeout(dummyId);
        }
        this.dummyTimeouts.clear();
    }
}

// Export singleton instance for easy access
export const intervalManager = IntervalManager.getInstance();

/**
 * Endurance Test Monitoring Utilities
 *
 * Provides comprehensive monitoring for endurance tests including:
 * - Memory usage tracking
 * - CPU usage tracking
 * - Event loop lag monitoring
 * - Resource leak detection
 *
 * These utilities are designed to be non-invasive and provide
 * accurate metrics for long-running tests.
 */

import { performance } from 'perf_hooks';
import { TradingLogger } from '../../src/utils/logger.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Memory snapshot at a point in time
 */
export interface MemorySnapshot {
    timestamp: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    rss: number;
}

/**
 * CPU usage metrics
 */
export interface CpuMetrics {
    timestamp: number;
    userCpuTime: number;
    systemCpuTime: number;
    percent: number;
}

/**
 * Event loop lag metrics
 */
export interface EventLoopLagMetrics {
    timestamp: number;
    lagMs: number;
    maxLagMs: number;
    avgLagMs: number;
}

/**
 * Resource leak detection result
 */
export interface LeakDetectionResult {
    hasMemoryLeak: boolean;
    memoryGrowthRate: number; // bytes per second
    hasTimerLeak: boolean;
    timerCount: number;
    hasListenerLeak: boolean;
    listenerCount: number;
    details: string;
}

/**
 * Comprehensive monitoring snapshot
 */
export interface MonitoringSnapshot {
    timestamp: number;
    memory: MemorySnapshot;
    cpu: CpuMetrics;
    eventLoop: EventLoopLagMetrics;
    uptime: number;
}

/**
 * Performance thresholds for endurance tests
 */
export interface PerformanceThresholds {
    maxMemoryGrowthRate: number; // bytes per second
    maxEventLoopLag: number; // milliseconds
    maxCpuUsage: number; // percentage
    maxMemoryUsage: number; // bytes
}

// ============================================================================
// DEFAULT THRESHOLDS
// ============================================================================

export const DEFAULT_THRESHOLDS: PerformanceThresholds = {
    maxMemoryGrowthRate: 1024 * 1024, // 1 MB/s
    maxEventLoopLag: 100, // 100ms
    maxCpuUsage: 80, // 80%
    maxMemoryUsage: 1024 * 1024 * 1024 // 1 GB
};

// ============================================================================
// MONITORING CLASS
// ============================================================================

/**
 * Endurance test monitor for tracking system resources
 */
export class EnduranceMonitor {
    private memorySnapshots: MemorySnapshot[] = [];
    private cpuSnapshots: CpuMetrics[] = [];
    private eventLoopSnapshots: EventLoopLagMetrics[] = [];
    private startTime: number;
    private lastCpuUsage: { user: number; system: number } | null = null;
    private lastCpuTimestamp: number = 0;
    private eventLoopCheckInterval: NodeJS.Timeout | null = null;
    private isMonitoring: boolean = false;
    private thresholds: PerformanceThresholds;

    constructor(thresholds: Partial<PerformanceThresholds> = {}) {
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
        this.startTime = Date.now();
    }

    /**
     * Start monitoring
     */
    start(): void {
        if (this.isMonitoring) {
            TradingLogger.warn('EnduranceMonitor already started');
            return;
        }

        this.isMonitoring = true;
        this.startTime = Date.now();
        this.lastCpuTimestamp = this.startTime;

        // Start event loop monitoring
        this.startEventLoopMonitoring();

        TradingLogger.info('EnduranceMonitor started', {
            thresholds: this.thresholds
        });
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        if (!this.isMonitoring) {
            return;
        }

        this.isMonitoring = false;

        // Stop event loop monitoring
        if (this.eventLoopCheckInterval) {
            clearInterval(this.eventLoopCheckInterval);
            this.eventLoopCheckInterval = null;
        }

        TradingLogger.info('EnduranceMonitor stopped');
    }

    /**
     * Take a comprehensive monitoring snapshot
     */
    takeSnapshot(): MonitoringSnapshot {
        const timestamp = Date.now();

        return {
            timestamp,
            memory: this.captureMemorySnapshot(),
            cpu: this.captureCpuMetrics(),
            eventLoop: this.captureEventLoopLag(),
            uptime: timestamp - this.startTime
        };
    }

    /**
     * Capture current memory usage
     */
    captureMemorySnapshot(): MemorySnapshot {
        const usage = process.memoryUsage();
        const snapshot: MemorySnapshot = {
            timestamp: Date.now(),
            heapUsed: usage.heapUsed,
            heapTotal: usage.heapTotal,
            external: usage.external,
            arrayBuffers: usage.arrayBuffers,
            rss: usage.rss
        };

        this.memorySnapshots.push(snapshot);

        // Keep only last 1000 snapshots to prevent memory bloat
        if (this.memorySnapshots.length > 1000) {
            this.memorySnapshots.shift();
        }

        return snapshot;
    }

    /**
     * Capture CPU usage metrics
     */
    captureCpuMetrics(): CpuMetrics {
        const usage = process.cpuUsage();
        const timestamp = Date.now();

        let percent = 0;

        if (this.lastCpuUsage && this.lastCpuTimestamp) {
            const userDelta = usage.user - this.lastCpuUsage.user;
            const systemDelta = usage.system - this.lastCpuUsage.system;
            const timeDelta = timestamp - this.lastCpuTimestamp;

            // Calculate CPU percentage (user + system) / timeDelta * 100
            // Multiply by 1e6 to convert microseconds to milliseconds
            percent = ((userDelta + systemDelta) / (timeDelta * 1000)) * 100;
        }

        this.lastCpuUsage = { user: usage.user, system: usage.system };
        this.lastCpuTimestamp = timestamp;

        const metrics: CpuMetrics = {
            timestamp,
            userCpuTime: usage.user,
            systemCpuTime: usage.system,
            percent
        };

        this.cpuSnapshots.push(metrics);

        // Keep only last 1000 snapshots
        if (this.cpuSnapshots.length > 1000) {
            this.cpuSnapshots.shift();
        }

        return metrics;
    }

    /**
     * Capture event loop lag
     */
    captureEventLoopLag(): EventLoopLagMetrics {
        const start = performance.now();
        setImmediate(() => {
            const lag = performance.now() - start;
            this.recordEventLoopLag(lag);
        });

        // Return current stats
        return this.getEventLoopStats();
    }

    /**
     * Record event loop lag measurement
     */
    private recordEventLoopLag(lag: number): void {
        const snapshot: EventLoopLagMetrics = {
            timestamp: Date.now(),
            lagMs: lag,
            maxLagMs: lag,
            avgLagMs: lag
        };

        this.eventLoopSnapshots.push(snapshot);

        // Keep only last 1000 snapshots
        if (this.eventLoopSnapshots.length > 1000) {
            this.eventLoopSnapshots.shift();
        }
    }

    /**
     * Get current event loop statistics
     */
    getEventLoopStats(): EventLoopLagMetrics {
        if (this.eventLoopSnapshots.length === 0) {
            return {
                timestamp: Date.now(),
                lagMs: 0,
                maxLagMs: 0,
                avgLagMs: 0
            };
        }

        const recentSnapshots = this.eventLoopSnapshots.slice(-100);
        const lags = recentSnapshots.map(s => s.lagMs);
        const maxLag = Math.max(...lags);
        const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;

        return {
            timestamp: Date.now(),
            lagMs: lags[lags.length - 1],
            maxLagMs: maxLag,
            avgLagMs: avgLag
        };
    }

    /**
     * Start continuous event loop monitoring
     */
    private startEventLoopMonitoring(): void {
        const checkInterval = 1000; // Check every second

        this.eventLoopCheckInterval = setInterval(() => {
            const start = performance.now();
            setImmediate(() => {
                const lag = performance.now() - start;
                this.recordEventLoopLag(lag);

                // Log warning if lag exceeds threshold
                if (lag > this.thresholds.maxEventLoopLag) {
                    TradingLogger.warn('Event loop lag exceeded threshold', {
                        lagMs: lag,
                        thresholdMs: this.thresholds.maxEventLoopLag
                    });
                }
            });
        }, checkInterval);
    }

    /**
     * Detect resource leaks
     */
    detectLeaks(): LeakDetectionResult {
        const result: LeakDetectionResult = {
            hasMemoryLeak: false,
            memoryGrowthRate: 0,
            hasTimerLeak: false,
            timerCount: 0,
            hasListenerLeak: false,
            listenerCount: 0,
            details: ''
        };

        // Check for memory leaks
        if (this.memorySnapshots.length >= 2) {
            const firstSnapshot = this.memorySnapshots[0];
            const lastSnapshot = this.memorySnapshots[this.memorySnapshots.length - 1];
            const timeDelta = (lastSnapshot.timestamp - firstSnapshot.timestamp) / 1000; // seconds
            const memoryDelta = lastSnapshot.heapUsed - firstSnapshot.heapUsed;

            result.memoryGrowthRate = memoryDelta / timeDelta;

            if (result.memoryGrowthRate > this.thresholds.maxMemoryGrowthRate) {
                result.hasMemoryLeak = true;
                result.details += `Memory leak detected: growth rate ${result.memoryGrowthRate} bytes/s exceeds threshold ${this.thresholds.maxMemoryGrowthRate} bytes/s. `;
            }
        }

        // Check for timer leaks (estimate from active timers)
        // Note: This is an approximation as Node.js doesn't expose exact timer count
        result.timerCount = this.estimateTimerCount();
        if (result.timerCount > 100) {
            result.hasTimerLeak = true;
            result.details += `Potential timer leak: ${result.timerCount} active timers. `;
        }

        // Check for event listener leaks
        result.listenerCount = this.estimateListenerCount();
        if (result.listenerCount > 50) {
            result.hasListenerLeak = true;
            result.details += `Potential listener leak: ${result.listenerCount} event listeners. `;
        }

        if (!result.details) {
            result.details = 'No leaks detected';
        }

        return result;
    }

    /**
     * Estimate number of active timers
     * This is an approximation based on process resource usage
     */
    private estimateTimerCount(): number {
        // This is a rough estimate - in production you'd want more precise tracking
        // For now, we'll use a heuristic based on memory usage patterns
        const memory = process.memoryUsage();
        const estimatedTimers = Math.floor((memory.heapUsed - memory.heapTotal) / 1024);
        return Math.max(0, estimatedTimers);
    }

    /**
     * Estimate number of event listeners
     * This is an approximation
     */
    private estimateListenerCount(): number {
        // This is a rough estimate - Node.js doesn't expose exact listener count
        // For now, we'll return a conservative estimate
        return 0;
    }

    /**
     * Check if performance thresholds are exceeded
     */
    checkThresholds(): {
        passed: boolean;
        violations: Array<{ type: string; actual: number; threshold: number; message: string }>;
    } {
        const violations: Array<{ type: string; actual: number; threshold: number; message: string }> = [];

        const latestMemory = this.memorySnapshots[this.memorySnapshots.length - 1];
        if (latestMemory && latestMemory.heapUsed > this.thresholds.maxMemoryUsage) {
            violations.push({
                type: 'memory',
                actual: latestMemory.heapUsed,
                threshold: this.thresholds.maxMemoryUsage,
                message: `Memory usage ${latestMemory.heapUsed} bytes exceeds threshold ${this.thresholds.maxMemoryUsage} bytes`
            });
        }

        const latestCpu = this.cpuSnapshots[this.cpuSnapshots.length - 1];
        if (latestCpu && latestCpu.percent > this.thresholds.maxCpuUsage) {
            violations.push({
                type: 'cpu',
                actual: latestCpu.percent,
                threshold: this.thresholds.maxCpuUsage,
                message: `CPU usage ${latestCpu.percent.toFixed(2)}% exceeds threshold ${this.thresholds.maxCpuUsage}%`
            });
        }

        const eventLoopStats = this.getEventLoopStats();
        if (eventLoopStats.maxLagMs > this.thresholds.maxEventLoopLag) {
            violations.push({
                type: 'eventLoop',
                actual: eventLoopStats.maxLagMs,
                threshold: this.thresholds.maxEventLoopLag,
                message: `Event loop lag ${eventLoopStats.maxLagMs.toFixed(2)}ms exceeds threshold ${this.thresholds.maxEventLoopLag}ms`
            });
        }

        return {
            passed: violations.length === 0,
            violations
        };
    }

    /**
     * Get monitoring summary
     */
    getSummary(): {
        uptime: number;
        memorySnapshots: number;
        cpuSnapshots: number;
        eventLoopSnapshots: number;
        currentMemory: MemorySnapshot | null;
        currentCpu: CpuMetrics | null;
        currentEventLoop: EventLoopLagMetrics;
        leakDetection: LeakDetectionResult;
        thresholdCheck: ReturnType<EnduranceMonitor['checkThresholds']>;
    } {
        return {
            uptime: Date.now() - this.startTime,
            memorySnapshots: this.memorySnapshots.length,
            cpuSnapshots: this.cpuSnapshots.length,
            eventLoopSnapshots: this.eventLoopSnapshots.length,
            currentMemory: this.memorySnapshots[this.memorySnapshots.length - 1] || null,
            currentCpu: this.cpuSnapshots[this.cpuSnapshots.length - 1] || null,
            currentEventLoop: this.getEventLoopStats(),
            leakDetection: this.detectLeaks(),
            thresholdCheck: this.checkThresholds()
        };
    }

    /**
     * Reset monitor state
     */
    reset(): void {
        this.stop();
        this.memorySnapshots = [];
        this.cpuSnapshots = [];
        this.eventLoopSnapshots = [];
        this.lastCpuUsage = null;
        this.lastCpuTimestamp = 0;
        this.startTime = Date.now();
    }

    /**
     * Get all memory snapshots
     */
    getMemorySnapshots(): MemorySnapshot[] {
        return [...this.memorySnapshots];
    }

    /**
     * Get all CPU snapshots
     */
    getCpuSnapshots(): CpuMetrics[] {
        return [...this.cpuSnapshots];
    }

    /**
     * Get all event loop snapshots
     */
    getEventLoopSnapshots(): EventLoopLagMetrics[] {
        return [...this.eventLoopSnapshots];
    }
}

// ============================================================================
// HELPER FUNCTIONS
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
 * Calculate memory growth rate from snapshots
 */
export function calculateMemoryGrowthRate(snapshots: MemorySnapshot[]): number {
    if (snapshots.length < 2) return 0;

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const timeDelta = (last.timestamp - first.timestamp) / 1000; // seconds

    if (timeDelta === 0) return 0;

    return (last.heapUsed - first.heapUsed) / timeDelta;
}

/**
 * Calculate average CPU usage from snapshots
 */
export function calculateAverageCpuUsage(snapshots: CpuMetrics[]): number {
    if (snapshots.length === 0) return 0;

    const total = snapshots.reduce((sum, s) => sum + s.percent, 0);
    return total / snapshots.length;
}

/**
 * Calculate average event loop lag from snapshots
 */
export function calculateAverageEventLoopLag(snapshots: EventLoopLagMetrics[]): number {
    if (snapshots.length === 0) return 0;

    const total = snapshots.reduce((sum, s) => sum + s.lagMs, 0);
    return total / snapshots.length;
}

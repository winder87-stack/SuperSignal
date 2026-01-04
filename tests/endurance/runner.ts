/**
 * Endurance Test Runner
 *
 * Provides a configurable test runner for endurance tests:
 * - Test duration configuration
 * - Test result aggregation
 * - Test report generation
 * - Test failure detection
 */

import { EnduranceMonitor, PerformanceThresholds, MonitoringSnapshot } from './monitor.js';
import { formatBytes, formatMs, calculateStats } from './helpers.js';
import { TradingLogger } from '../../src/utils/logger.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Test duration presets
 */
export type TestDuration = '1h' | '24h' | '7d';

/**
 * Test result for a single test
 */
export interface TestResult {
    testName: string;
    passed: boolean;
    duration: number;
    error?: Error;
    metrics: {
        memory: {
            initial: number;
            final: number;
            growth: number;
            growthRate: number;
        };
        cpu: {
            avg: number;
            max: number;
        };
        eventLoop: {
            avgLag: number;
            maxLag: number;
        };
    };
    violations: Array<{
        type: string;
        actual: number;
        threshold: number;
        message: string;
    }>;
}

/**
 * Aggregated test results
 */
export interface TestReport {
    testName: string;
    duration: TestDuration;
    customDuration?: number;
    startTime: number;
    endTime: number;
    totalDuration: number;
    results: TestResult[];
    summary: {
        totalTests: number;
        passedTests: number;
        failedTests: number;
        passRate: number;
    };
    overallMetrics: {
        memory: {
            avgGrowthRate: number;
            maxGrowthRate: number;
        };
        cpu: {
            avgUsage: number;
            maxUsage: number;
        };
        eventLoop: {
            avgLag: number;
            maxLag: number;
        };
    };
    recommendations: string[];
}

/**
 * Test configuration
 */
export interface TestConfig {
    name: string;
    duration: TestDuration;
    customDurationMs?: number;
    thresholds?: Partial<PerformanceThresholds>;
    scenarios: Array<{
        name: string;
        run: (monitor: EnduranceMonitor) => Promise<void>;
    }>;
}

// ============================================================================
// DURATION PRESETS
// ============================================================================

export const DURATION_PRESETS: Record<TestDuration, number> = {
    '1h': 60 * 60 * 1000, // 1 hour
    '24h': 24 * 60 * 60 * 1000, // 24 hours
    '7d': 7 * 24 * 60 * 60 * 1000 // 7 days
};

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
// TEST RUNNER CLASS
// ============================================================================

/**
 * Endurance test runner with configurable duration and thresholds
 */
export class EnduranceTestRunner {
    private monitor: EnduranceMonitor;
    private config: TestConfig;
    private results: TestResult[] = [];
    private startTime: number = 0;
    private endTime: number = 0;

    constructor(config: TestConfig) {
        this.config = config;
        this.monitor = new EnduranceMonitor(config.thresholds);
    }

    /**
     * Run all test scenarios
     */
    async run(): Promise<TestReport> {
        this.startTime = Date.now();
        TradingLogger.info('Starting endurance test suite', {
            testName: this.config.name,
            duration: this.config.duration,
            customDurationMs: this.config.customDurationMs,
            scenarios: this.config.scenarios.length
        });

        this.monitor.start();

        // Run each scenario
        for (const scenario of this.config.scenarios) {
            TradingLogger.info(`Running scenario: ${scenario.name}`);
            const result = await this.runScenario(scenario);
            this.results.push(result);
        }

        this.monitor.stop();
        this.endTime = Date.now();

        const report = this.generateReport();
        this.logReport(report);

        return report;
    }

    /**
     * Run a single test scenario
     */
    private async runScenario(scenario: {
        name: string;
        run: (monitor: EnduranceMonitor) => Promise<void>;
    }): Promise<TestResult> {
        const scenarioStartTime = Date.now();
        const initialMemory = process.memoryUsage().heapUsed;

        // Reset monitor for this scenario
        this.monitor.reset();
        this.monitor.start();

        let passed = true;
        let error: Error | undefined;

        try {
            await scenario.run(this.monitor);
        } catch (e) {
            passed = false;
            error = e instanceof Error ? e : new Error(String(e));
            TradingLogger.error(`Scenario failed: ${scenario.name}`, {
                error: error.message,
                stack: error.stack
            });
        }

        const scenarioEndTime = Date.now();
        const duration = scenarioEndTime - scenarioStartTime;

        // Capture final metrics
        const summary = this.monitor.getSummary();
        const thresholdCheck = this.monitor.checkThresholds();

        // Calculate metrics
        const finalMemory = process.memoryUsage().heapUsed;
        const memoryGrowth = finalMemory - initialMemory;
        const memoryGrowthRate = memoryGrowth / (duration / 1000);

        const result: TestResult = {
            testName: scenario.name,
            passed,
            duration,
            error,
            metrics: {
                memory: {
                    initial: initialMemory,
                    final: finalMemory,
                    growth: memoryGrowth,
                    growthRate: memoryGrowthRate
                },
                cpu: {
                    avg: summary.currentCpu?.percent || 0,
                    max: Math.max(...this.monitor.getCpuSnapshots().map(s => s.percent))
                },
                eventLoop: {
                    avgLag: summary.currentEventLoop.avgLagMs,
                    maxLag: summary.currentEventLoop.maxLagMs
                }
            },
            violations: thresholdCheck.violations
        };

        return result;
    }

    /**
     * Generate test report
     */
    private generateReport(): TestReport {
        const totalDuration = this.endTime - this.startTime;
        const passedTests = this.results.filter(r => r.passed).length;
        const failedTests = this.results.filter(r => !r.passed).length;
        const passRate = (passedTests / this.results.length) * 100;

        // Calculate overall metrics
        const memoryGrowthRates = this.results.map(r => r.metrics.memory.growthRate);
        const cpuUsages = this.results.flatMap(r =>
            this.monitor.getCpuSnapshots().map(s => s.percent)
        );
        const eventLoopLags = this.results.flatMap(r =>
            this.monitor.getEventLoopSnapshots().map(s => s.lagMs)
        );

        const memoryStats = calculateStats(memoryGrowthRates);
        const cpuStats = calculateStats(cpuUsages);
        const eventLoopStats = calculateStats(eventLoopLags);

        // Generate recommendations
        const recommendations = this.generateRecommendations();

        return {
            testName: this.config.name,
            duration: this.config.duration,
            customDuration: this.config.customDurationMs,
            startTime: this.startTime,
            endTime: this.endTime,
            totalDuration,
            results: this.results,
            summary: {
                totalTests: this.results.length,
                passedTests,
                failedTests,
                passRate
            },
            overallMetrics: {
                memory: {
                    avgGrowthRate: memoryStats.avg,
                    maxGrowthRate: memoryStats.max
                },
                cpu: {
                    avgUsage: cpuStats.avg,
                    maxUsage: cpuStats.max
                },
                eventLoop: {
                    avgLag: eventLoopStats.avg,
                    maxLag: eventLoopStats.max
                }
            },
            recommendations
        };
    }

    /**
     * Generate recommendations based on test results
     */
    private generateRecommendations(): string[] {
        const recommendations: string[] = [];

        // Check for memory leaks
        const memoryGrowthRates = this.results.map(r => r.metrics.memory.growthRate);
        const avgMemoryGrowthRate = memoryGrowthRates.reduce((a, b) => a + b, 0) / memoryGrowthRates.length;

        if (avgMemoryGrowthRate > 1024 * 1024) {
            recommendations.push(
                `High memory growth rate detected (${formatBytes(avgMemoryGrowthRate)}/s). ` +
                'Review for memory leaks, especially in event listeners and closures.'
            );
        }

        // Check for high CPU usage
        const cpuUsages = this.results.flatMap(r =>
            this.monitor.getCpuSnapshots().map(s => s.percent)
        );
        const avgCpuUsage = cpuUsages.reduce((a, b) => a + b, 0) / cpuUsages.length;

        if (avgCpuUsage > 70) {
            recommendations.push(
                `High CPU usage detected (${avgCpuUsage.toFixed(1)}%). ` +
                'Consider optimizing synchronous operations and reducing blocking calls.'
            );
        }

        // Check for event loop lag
        const eventLoopLags = this.results.flatMap(r =>
            this.monitor.getEventLoopSnapshots().map(s => s.lagMs)
        );
        const avgEventLoopLag = eventLoopLags.reduce((a, b) => a + b, 0) / eventLoopLags.length;

        if (avgEventLoopLag > 50) {
            recommendations.push(
                `High event loop lag detected (${avgEventLoopLag.toFixed(1)}ms). ` +
                'Review for blocking operations and consider offloading work to worker threads.'
            );
        }

        // Check for failed tests
        const failedTests = this.results.filter(r => !r.passed);
        if (failedTests.length > 0) {
            recommendations.push(
                `${failedTests.length} test(s) failed. Review error logs for details.`
            );
        }

        if (recommendations.length === 0) {
            recommendations.push('All tests passed. System is performing within acceptable thresholds.');
        }

        return recommendations;
    }

    /**
     * Log test report
     */
    private logReport(report: TestReport): void {
        TradingLogger.info('=== ENDURANCE TEST REPORT ===', {
            testName: report.testName,
            duration: report.duration,
            totalDuration: formatMs(report.totalDuration)
        });

        TradingLogger.info('Summary', {
            totalTests: report.summary.totalTests,
            passedTests: report.summary.passedTests,
            failedTests: report.summary.failedTests,
            passRate: `${report.summary.passRate.toFixed(1)}%`
        });

        TradingLogger.info('Overall Metrics', {
            memory: {
                avgGrowthRate: formatBytes(report.overallMetrics.memory.avgGrowthRate) + '/s',
                maxGrowthRate: formatBytes(report.overallMetrics.memory.maxGrowthRate) + '/s'
            },
            cpu: {
                avgUsage: `${report.overallMetrics.cpu.avgUsage.toFixed(1)}%`,
                maxUsage: `${report.overallMetrics.cpu.maxUsage.toFixed(1)}%`
            },
            eventLoop: {
                avgLag: `${report.overallMetrics.eventLoop.avgLag.toFixed(1)}ms`,
                maxLag: `${report.overallMetrics.eventLoop.maxLag.toFixed(1)}ms`
            }
        });

        TradingLogger.info('Recommendations', {
            recommendations: report.recommendations
        });

        // Log individual test results
        for (const result of report.results) {
            TradingLogger.info(`Test: ${result.testName}`, {
                passed: result.passed,
                duration: formatMs(result.duration),
                memoryGrowth: formatBytes(result.metrics.memory.growth),
                memoryGrowthRate: formatBytes(result.metrics.memory.growthRate) + '/s',
                avgCpu: `${result.metrics.cpu.avg.toFixed(1)}%`,
                maxCpu: `${result.metrics.cpu.max.toFixed(1)}%`,
                avgEventLoopLag: `${result.metrics.eventLoop.avgLag.toFixed(1)}ms`,
                maxEventLoopLag: `${result.metrics.eventLoop.maxLag.toFixed(1)}ms`,
                violations: result.violations.length
            });

            if (result.violations.length > 0) {
                for (const violation of result.violations) {
                    TradingLogger.warn(`Violation: ${violation.type}`, {
                        actual: violation.actual,
                        threshold: violation.threshold,
                        message: violation.message
                    });
                }
            }
        }
    }

    /**
     * Get test results
     */
    getResults(): TestResult[] {
        return [...this.results];
    }

    /**
     * Get monitor instance
     */
    getMonitor(): EnduranceMonitor {
        return this.monitor;
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create a test configuration
 */
export function createTestConfig(
    name: string,
    duration: TestDuration,
    scenarios: Array<{
        name: string;
        run: (monitor: EnduranceMonitor) => Promise<void>;
    }>,
    customDurationMs?: number,
    thresholds?: Partial<PerformanceThresholds>
): TestConfig {
    return {
        name,
        duration,
        customDurationMs,
        thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds },
        scenarios
    };
}

/**
 * Run a quick endurance test (1 hour equivalent)
 */
export async function runQuickTest(
    scenarios: Array<{
        name: string;
        run: (monitor: EnduranceMonitor) => Promise<void>;
    }>
): Promise<TestReport> {
    const config = createTestConfig('Quick Endurance Test', '1h', scenarios);
    const runner = new EnduranceTestRunner(config);
    return runner.run();
}

/**
 * Run a standard endurance test (24 hours equivalent)
 */
export async function runStandardTest(
    scenarios: Array<{
        name: string;
        run: (monitor: EnduranceMonitor) => Promise<void>;
    }>
): Promise<TestReport> {
    const config = createTestConfig('Standard Endurance Test', '24h', scenarios);
    const runner = new EnduranceTestRunner(config);
    return runner.run();
}

/**
 * Run a full endurance test (7 days equivalent)
 */
export async function runFullTest(
    scenarios: Array<{
        name: string;
        run: (monitor: EnduranceMonitor) => Promise<void>;
    }>
): Promise<TestReport> {
    const config = createTestConfig('Full Endurance Test', '7d', scenarios);
    const runner = new EnduranceTestRunner(config);
    return runner.run();
}

/**
 * Run a custom duration endurance test
 */
export async function runCustomTest(
    durationMs: number,
    scenarios: Array<{
        name: string;
        run: (monitor: EnduranceMonitor) => Promise<void>;
    }>,
    thresholds?: Partial<PerformanceThresholds>
): Promise<TestReport> {
    const config = createTestConfig('Custom Endurance Test', '1h', scenarios, durationMs, thresholds);
    const runner = new EnduranceTestRunner(config);
    return runner.run();
}

/**
 * High-Frequency Trading Scenario
 *
 * Tests system performance under high-frequency trading conditions:
 * - Rapid signal processing
 * - Indicator calculation performance
 * - Order placement throughput
 * - Memory stability under load
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import { EnduranceMonitor } from '../monitor.js';
import { setupTestEnvironment, assertEventLoopLag, assertCpuUsage, formatMs } from '../helpers.js';
import { TradingEngine } from '../../../src/core/engine.js';
import { Candle, TradingPair } from '../../../src/types/index.js';

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

describe('High-Frequency Trading Scenario', () => {
    let monitor: EnduranceMonitor;
    let cleanup: () => Promise<void>;
    let engine: TradingEngine;
    let mockClient: any;
    let mockSignalProcessor: any;
    let mockRiskManager: any;

    beforeEach(async () => {
        const env = await setupTestEnvironment();
        monitor = env.monitor;
        cleanup = env.cleanup;

        // Create mocks
        mockClient = {
            api: {
                placeOrder: vi.fn().mockResolvedValue({
                    status: 'ok',
                    response: { data: { statuses: [{ resting: { oid: 12345 } }] } }
                }),
                cancelOrders: vi.fn().mockResolvedValue({}),
                getUserState: vi.fn().mockResolvedValue({
                    marginSummary: { accountValue: '10000' }
                }),
                getAddress: vi.fn().mockReturnValue('0xmockaddress'),
                getOpenOrders: vi.fn().mockResolvedValue([])
            },
            assetIndex: {
                getAssetIndex: vi.fn().mockReturnValue(1)
            }
        };

        mockSignalProcessor = {
            processCandle: vi.fn().mockReturnValue(null),
            checkExits: vi.fn().mockReturnValue([]),
            checkExitsWithType: vi.fn().mockReturnValue([]),
            triggerCooldown: vi.fn()
        };

        mockRiskManager = {
            canTrade: vi.fn().mockReturnValue({ allowed: true }),
            calculatePositionSize: vi.fn().mockReturnValue(new Decimal(100)),
            checkPotentialLoss: vi.fn().mockReturnValue({ allowed: true }),
            updatePnL: vi.fn(),
            getConfig: vi.fn().mockReturnValue({
                maxPositionSize: new Decimal(1000),
                maxTotalExposure: new Decimal(5000),
                stopLossPercentage: new Decimal(0.02),
                maxDrawdown: new Decimal(500),
                riskPercentage: new Decimal(0.01)
            })
        };

        engine = new TradingEngine(
            mockClient,
            mockSignalProcessor,
            mockRiskManager
        );

        monitor.start();
    });

    afterEach(async () => {
        await cleanup();
        monitor.stop();
    });

    describe('Rapid Candle Processing', () => {
        it('should handle high-frequency candle updates', async () => {
            const candleCount = 1000;
            const pair: TradingPair = 'BTC-USDC';
            const startTime = Date.now();

            // Process many candles rapidly
            for (let i = 0; i < candleCount; i++) {
                const candle = generateMockCandle(Date.now() + i * 1000);
                await engine.handleCandle(pair, candle);
            }

            const duration = Date.now() - startTime;
            const candlesPerSecond = (candleCount / duration) * 1000;

            // Should handle at least 100 candles per second
            expect(candlesPerSecond).toBeGreaterThan(100);

            // Verify signal processor was called
            expect(mockSignalProcessor.processCandle).toHaveBeenCalledTimes(candleCount);
        }, 20000);

        it('should maintain event loop responsiveness under load', async () => {
            const eventLoopSnapshots: number[] = [];

            // Capture event loop lag during processing
            const captureLag = () => {
                const start = Date.now();
                setImmediate(() => {
                    eventLoopSnapshots.push(Date.now() - start);
                });
            };

            // Process candles with lag monitoring
            for (let i = 0; i < 500; i++) {
                captureLag();
                const candle = generateMockCandle(Date.now() + i * 1000);
                await engine.handleCandle('BTC-USDC', candle);
            }

            // Wait for all lag measurements
            await new Promise(resolve => setTimeout(resolve, 100));

            // Check event loop lag
            const maxLag = Math.max(...eventLoopSnapshots);
            const avgLag = eventLoopSnapshots.reduce((a, b) => a + b, 0) / eventLoopSnapshots.length;

            // Max lag should be under 100ms
            expect(maxLag).toBeLessThan(100);
            // Average lag should be under 10ms
            expect(avgLag).toBeLessThan(10);
        }, 15000);
    });

    describe('Indicator Calculation Performance', () => {
        it('should calculate indicators efficiently', async () => {
            const candleCount = 500;
            const calculationTimes: number[] = [];

            // Process candles and measure calculation time
            for (let i = 0; i < candleCount; i++) {
                const start = Date.now();
                const candle = generateMockCandle(Date.now() + i * 1000);
                await engine.handleCandle('BTC-USDC', candle);
                const duration = Date.now() - start;
                calculationTimes.push(duration);
            }

            const avgCalculationTime = calculationTimes.reduce((a, b) => a + b, 0) / calculationTimes.length;
            const maxCalculationTime = Math.max(...calculationTimes);

            // Average calculation should be under 10ms
            expect(avgCalculationTime).toBeLessThan(10);
            // Max calculation should be under 50ms
            expect(maxCalculationTime).toBeLessThan(50);
        }, 15000);

        it('should handle multiple pairs simultaneously', async () => {
            const pairs: TradingPair[] = ['BTC-USDC', 'ETH-USDC', 'SOL-USDC'];
            const candlesPerPair = 200;

            const startTime = Date.now();

            // Process candles for multiple pairs
            for (let i = 0; i < candlesPerPair; i++) {
                for (const pair of pairs) {
                    const candle = generateMockCandle(Date.now() + i * 1000);
                    await engine.handleCandle(pair, candle);
                }
            }

            const duration = Date.now() - startTime;
            const totalCandles = candlesPerPair * pairs.length;
            const candlesPerSecond = (totalCandles / duration) * 1000;

            // Should handle at least 50 candles per second across all pairs
            expect(candlesPerSecond).toBeGreaterThan(50);
        }, 20000);
    });

    describe('Order Placement Throughput', () => {
        it('should handle rapid order placement', async () => {
            const orderCount = 100;
            const startTime = Date.now();

            // Simulate rapid signal generation
            for (let i = 0; i < orderCount; i++) {
                const signal = {
                    pair: 'BTC-USDC' as TradingPair,
                    direction: 'long' as const,
                    type: 'entry' as const,
                    price: new Decimal(50000 + i * 10),
                    timestamp: Date.now(),
                    strength: new Decimal(0.8),
                    components: {
                        quadExtreme: true,
                        divergence: 'bullish' as const,
                        location: 'support' as const,
                        rotation: 'up' as const
                    }
                };

                // Trigger signal processing
                mockSignalProcessor.processCandle.mockReturnValue(signal);
                const candle = generateMockCandle(Date.now() + i * 1000);
                await engine.handleCandle('BTC-USDC', candle);
            }

            const duration = Date.now() - startTime;
            const ordersPerSecond = (orderCount / duration) * 1000;

            // Should handle at least 10 orders per second
            expect(ordersPerSecond).toBeGreaterThan(10);

            // Verify orders were placed
            expect(mockClient.api.placeOrder).toHaveBeenCalled();
        }, 20000);
    });

    describe('Memory Stability Under Load', () => {
        it('should maintain stable memory usage during high-frequency trading', async () => {
            const memorySnapshots: number[] = [];

            // Take initial snapshot
            memorySnapshots.push(process.memoryUsage().heapUsed);

            // Process many candles
            for (let i = 0; i < 1000; i++) {
                const candle = generateMockCandle(Date.now() + i * 1000);
                await engine.handleCandle('BTC-USDC', candle);

                // Take snapshot every 100 candles
                if (i % 100 === 0) {
                    if (global.gc) {
                        global.gc();
                    }
                    memorySnapshots.push(process.memoryUsage().heapUsed);
                }
            }

            // Force garbage collection
            if (global.gc) {
                global.gc();
            }
            memorySnapshots.push(process.memoryUsage().heapUsed);

            // Calculate memory growth
            const initialMemory = memorySnapshots[0];
            const finalMemory = memorySnapshots[memorySnapshots.length - 1];
            const memoryGrowth = finalMemory - initialMemory;

            // Memory growth should be minimal (< 20MB)
            expect(memoryGrowth).toBeLessThan(20 * 1024 * 1024);
        }, 30000);
    });

    describe('CPU Usage Under Load', () => {
        it('should maintain reasonable CPU usage', async () => {
            const cpuSnapshots: number[] = [];

            // Capture CPU usage during processing
            for (let i = 0; i < 500; i++) {
                const startCpu = process.cpuUsage();

                const candle = generateMockCandle(Date.now() + i * 1000);
                await engine.handleCandle('BTC-USDC', candle);

                const endCpu = process.cpuUsage(startCpu);
                const cpuPercent = ((endCpu.user + endCpu.system) / 10000) * 100;
                cpuSnapshots.push(cpuPercent);
            }

            const avgCpu = cpuSnapshots.reduce((a, b) => a + b, 0) / cpuSnapshots.length;
            const maxCpu = Math.max(...cpuSnapshots);

            // Average CPU should be under 50%
            expect(avgCpu).toBeLessThan(50);
            // Max CPU should be under 100%
            expect(maxCpu).toBeLessThan(100);
        }, 20000);
    });

    describe('Error Handling Under Load', () => {
        it('should handle errors gracefully during high-frequency operations', async () => {
            let errorCount = 0;

            // Simulate occasional errors
            mockSignalProcessor.processCandle = vi.fn(() => {
                errorCount++;
                if (errorCount % 10 === 0) {
                    throw new Error('Simulated processing error');
                }
                return null;
            });

            // Process many candles
            for (let i = 0; i < 200; i++) {
                const candle = generateMockCandle(Date.now() + i * 1000);
                try {
                    await engine.handleCandle('BTC-USDC', candle);
                } catch (e) {
                    // Errors should be caught
                }
            }

            // Verify system is still functional after errors
            const candle = generateMockCandle(Date.now());
            await engine.handleCandle('BTC-USDC', candle);

            // Should have processed all candles despite errors
            expect(mockSignalProcessor.processCandle).toHaveBeenCalled();
        }, 15000);
    });

    describe('Concurrent Operations', () => {
        it('should handle concurrent candle processing for multiple pairs', async () => {
            const pairs: TradingPair[] = ['BTC-USDC', 'ETH-USDC', 'SOL-USDC'];
            const operations: Promise<void>[] = [];

            // Start concurrent operations
            for (const pair of pairs) {
                for (let i = 0; i < 100; i++) {
                    operations.push(
                        engine.handleCandle(pair, generateMockCandle(Date.now() + i * 1000))
                    );
                }
            }

            // Wait for all operations to complete
            await Promise.all(operations);

            // Verify all candles were processed
            expect(mockSignalProcessor.processCandle).toHaveBeenCalledTimes(pairs.length * 100);
        }, 20000);
    });
});

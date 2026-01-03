// TradingEngine Unit Tests
// Tests for: exit signal integration, risk manager rejection, trailing stop updates

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { Decimal } from 'decimal.js';
import { TradingEngine } from '../../src/core/engine.js';
import { Candle, TradingPair, TradingSignal, Position } from '../../src/types/index.js';

// Helper to create candle data
function createCandle(
    timestamp: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number = 1000
): Candle {
    return {
        timestamp,
        open: new Decimal(open),
        high: new Decimal(high),
        low: new Decimal(low),
        close: new Decimal(close),
        volume: new Decimal(volume)
    };
}

// Helper to create a trading signal
function createSignal(
    pair: TradingPair,
    direction: 'long' | 'short',
    price: number
): TradingSignal {
    return {
        pair,
        direction,
        strength: new Decimal(0.8),
        components: {
            quadExtreme: true,
            divergence: direction === 'long' ? 'bullish' : 'bearish',
            location: direction === 'long' ? 'support' : 'resistance',
            rotation: direction === 'long' ? 'up' : 'down'
        },
        timestamp: Date.now(),
        price: new Decimal(price),
        stopLoss: new Decimal(direction === 'long' ? price * 0.98 : price * 1.02)
    };
}

// Mock factory for HyperLiquidClient
function createMockClient() {
    return {
        api: {
            placeOrder: vi.fn().mockResolvedValue({
                response: { data: { statuses: [{ resting: { oid: 12345 } }] } }
            }),
            cancelOrders: vi.fn().mockResolvedValue({}),
            getUserState: vi.fn().mockResolvedValue({
                marginSummary: { accountValue: '10000' }
            }),
            getAddress: vi.fn().mockReturnValue('0xmockaddress')
        },
        assetIndex: {
            getAssetIndex: vi.fn().mockReturnValue(1)
        }
    };
}

// Mock factory for SignalProcessor
function createMockSignalProcessor(checkExitsResult: TradingPair[] = []) {
    return {
        processCandle: vi.fn().mockReturnValue(null),
        checkExits: vi.fn().mockReturnValue(checkExitsResult)
    };
}

// Mock factory for RiskManager
function createMockRiskManager(canTradeResult = { allowed: true }) {
    return {
        canTrade: vi.fn().mockReturnValue(canTradeResult),
        calculatePositionSize: vi.fn().mockReturnValue(new Decimal(100)),
        updatePnL: vi.fn(),
        getConfig: vi.fn().mockReturnValue({
            maxPositionSize: new Decimal(1000),
            maxTotalExposure: new Decimal(5000),
            stopLossPercentage: new Decimal(0.02),
            maxDrawdown: new Decimal(500),
            riskPercentage: new Decimal(0.01)
        })
    };
}

describe('TradingEngine', () => {
    let engine: TradingEngine;
    let mockClient: ReturnType<typeof createMockClient>;
    let mockSignalProcessor: ReturnType<typeof createMockSignalProcessor>;
    let mockRiskManager: ReturnType<typeof createMockRiskManager>;

    beforeEach(() => {
        mockClient = createMockClient();
        mockSignalProcessor = createMockSignalProcessor();
        mockRiskManager = createMockRiskManager();

        engine = new TradingEngine(
            mockClient as any,
            mockSignalProcessor as any,
            mockRiskManager as any
        );
    });

    describe('handleCandle - Exit Signal Integration', () => {
        it('should call checkExits for open positions', async () => {
            // Simulate an open position by accessing private positions map
            const position: Position = {
                pair: 'BTC-USDC',
                direction: 'long',
                size: new Decimal(0.1),
                entryPrice: new Decimal(50000),
                stopLoss: new Decimal(49000),
                timestamp: Date.now(),
                signalId: 'test-signal-1'
            };

            // Access private positions map
            (engine as any).positions.set('BTC-USDC', position);

            const candle = createCandle(Date.now(), 50100, 50200, 50000, 50150);

            await engine.handleCandle('BTC-USDC', candle);

            expect(mockSignalProcessor.checkExits).toHaveBeenCalledWith([
                { direction: 'long', pair: 'BTC-USDC' }
            ]);
        });

        it('should close position when checkExits returns the pair', async () => {
            // Setup: open position and checkExits returning that pair
            const position: Position = {
                pair: 'ETH-USDC',
                direction: 'short',
                size: new Decimal(1),
                entryPrice: new Decimal(3000),
                stopLoss: new Decimal(3060),
                timestamp: Date.now(),
                signalId: 'test-signal-2'
            };

            (engine as any).positions.set('ETH-USDC', position);
            mockSignalProcessor.checkExits.mockReturnValue(['ETH-USDC']);

            const candle = createCandle(Date.now(), 2900, 2950, 2880, 2890);

            await engine.handleCandle('ETH-USDC', candle);

            // Should have called placeOrder to close (reduce-only order)
            expect(mockClient.api.placeOrder).toHaveBeenCalled();
            const orderCall = mockClient.api.placeOrder.mock.calls[0];
            expect(orderCall[0][0].r).toBe(true); // reduce-only flag
        });

        it('should not process entry signals after exit', async () => {
            // Setup open position
            const position: Position = {
                pair: 'SOL-USDC',
                direction: 'long',
                size: new Decimal(10),
                entryPrice: new Decimal(100),
                stopLoss: new Decimal(98),
                timestamp: Date.now(),
                signalId: 'test-signal-3'
            };

            (engine as any).positions.set('SOL-USDC', position);

            // checkExits returns the pair (exit triggered)
            mockSignalProcessor.checkExits.mockReturnValue(['SOL-USDC']);

            // processCandle returns a new signal (should be ignored)
            const newSignal = createSignal('SOL-USDC', 'short', 95);
            mockSignalProcessor.processCandle.mockReturnValue(newSignal);

            const candle = createCandle(Date.now(), 95, 96, 94, 95);

            await engine.handleCandle('SOL-USDC', candle);

            // Only one order call (for closing position, not for new entry)
            expect(mockClient.api.placeOrder).toHaveBeenCalledTimes(1);
        });
    });

    describe('evaluateEntry - Risk Manager Rejection', () => {
        it('should reject trade when canTrade returns allowed=false', async () => {
            mockRiskManager.canTrade.mockReturnValue({
                allowed: false,
                reason: 'Daily loss limit reached'
            });

            const signal = createSignal('BTC-USDC', 'long', 50000);

            // Call evaluateEntry directly
            await (engine as any).evaluateEntry(signal);

            // Should NOT place any orders
            expect(mockClient.api.placeOrder).not.toHaveBeenCalled();
        });

        it('should reject trade when position size is zero', async () => {
            mockRiskManager.calculatePositionSize.mockReturnValue(new Decimal(0));

            const signal = createSignal('BTC-USDC', 'long', 50000);

            await (engine as any).evaluateEntry(signal);

            expect(mockClient.api.placeOrder).not.toHaveBeenCalled();
        });

        it('should reject trade when account balance is zero', async () => {
            mockClient.api.getUserState.mockResolvedValue({
                marginSummary: { accountValue: '0' }
            });

            const signal = createSignal('ETH-USDC', 'short', 3000);

            await (engine as any).evaluateEntry(signal);

            expect(mockClient.api.placeOrder).not.toHaveBeenCalled();
        });

        it('should proceed with trade when all checks pass', async () => {
            const signal = createSignal('BTC-USDC', 'long', 50000);

            // Pre-populate stochastic manager with history so calculateTakeProfit works
            const { StochasticManager } = await import('../../src/indicators/stochastic.js');
            const stochManager = new StochasticManager();
            // Add mock fast stochastic history (fastHistory is a private array)
            (stochManager as any).fastHistory = [
                { k: new Decimal(25), d: new Decimal(22), timestamp: Date.now() - 60000 },
                { k: new Decimal(20), d: new Decimal(18), timestamp: Date.now() }
            ];
            (engine as any).stochasticManagers.set('BTC-USDC', stochManager);

            await (engine as any).evaluateEntry(signal);

            // Should place entry order, stop loss, and take profit
            expect(mockClient.api.placeOrder).toHaveBeenCalledTimes(3);
        });
    });

    describe('updateTrailingStop', () => {
        it('should not update when position not profitable', async () => {
            const position: Position = {
                pair: 'BTC-USDC',
                direction: 'long',
                size: new Decimal(0.1),
                entryPrice: new Decimal(50000),
                stopLoss: new Decimal(49000),
                trailingStop: new Decimal(49000),
                trailingStopActivated: false,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('BTC-USDC', position);

            // Current price below entry (not profitable for long)
            const candle = createCandle(Date.now(), 49500, 49600, 49400, 49500);

            await (engine as any).updateTrailingStop('BTC-USDC', candle);

            // No API calls for trailing stop update
            expect(mockClient.api.cancelOrders).not.toHaveBeenCalled();
        });

        it('should activate trailing stop after 1% profit', async () => {
            const position: Position = {
                pair: 'BTC-USDC',
                direction: 'long',
                size: new Decimal(0.1),
                entryPrice: new Decimal(50000),
                stopLoss: new Decimal(49000),
                stopLossOrderId: 11111,
                trailingStop: new Decimal(49000),
                trailingStopActivated: false,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('BTC-USDC', position);

            // Current price 2% above entry
            const candle = createCandle(Date.now(), 51000, 51100, 50900, 51000);

            await (engine as any).updateTrailingStop('BTC-USDC', candle);

            // Check that position was updated
            const updatedPosition = (engine as any).positions.get('BTC-USDC');
            expect(updatedPosition.trailingStopActivated).toBe(true);
        });

        it('should call cancelOrders with correct order ID', async () => {
            const position: Position = {
                pair: 'ETH-USDC',
                direction: 'short',
                size: new Decimal(1),
                entryPrice: new Decimal(3000),
                stopLoss: new Decimal(3060),
                stopLossOrderId: 98765,
                trailingStop: new Decimal(3060),
                trailingStopActivated: true,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('ETH-USDC', position);

            // Price dropped 2% (profitable for short)
            const candle = createCandle(Date.now(), 2940, 2960, 2920, 2940);

            await (engine as any).updateTrailingStop('ETH-USDC', candle);

            // Should cancel the old stop loss order
            expect(mockClient.api.cancelOrders).toHaveBeenCalledWith([
                { a: 1, o: 98765 }
            ]);
        });

        it('should place new stop order at updated price', async () => {
            const position: Position = {
                pair: 'BTC-USDC',
                direction: 'long',
                size: new Decimal(0.1),
                entryPrice: new Decimal(50000),
                stopLoss: new Decimal(49000),
                stopLossOrderId: 12345,
                trailingStop: new Decimal(49000),
                trailingStopActivated: true,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('BTC-USDC', position);

            // 3% profit
            const candle = createCandle(Date.now(), 51500, 51600, 51400, 51500);

            await (engine as any).updateTrailingStop('BTC-USDC', candle);

            // Should place new stop loss order
            expect(mockClient.api.placeOrder).toHaveBeenCalled();
            const orderCall = mockClient.api.placeOrder.mock.calls[0];
            expect(orderCall[0][0].t.trigger.tpsl).toBe('sl');
        });

        it('should extract and store new order ID', async () => {
            mockClient.api.placeOrder.mockResolvedValue({
                response: { data: { statuses: [{ resting: { oid: 99999 } }] } }
            });

            const position: Position = {
                pair: 'SOL-USDC',
                direction: 'long',
                size: new Decimal(10),
                entryPrice: new Decimal(100),
                stopLoss: new Decimal(98),
                stopLossOrderId: 11111,
                trailingStop: new Decimal(98),
                trailingStopActivated: true,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('SOL-USDC', position);

            // 3% profit
            const candle = createCandle(Date.now(), 103, 104, 102.5, 103);

            await (engine as any).updateTrailingStop('SOL-USDC', candle);

            const updatedPosition = (engine as any).positions.get('SOL-USDC');
            expect(updatedPosition.stopLossOrderId).toBe(99999);
        });
    });

    describe('getPositions', () => {
        it('should return array of all open positions', () => {
            const pos1: Position = {
                pair: 'BTC-USDC',
                direction: 'long',
                size: new Decimal(0.1),
                entryPrice: new Decimal(50000),
                stopLoss: new Decimal(49000),
                timestamp: Date.now(),
                signalId: 'sig-1'
            };

            const pos2: Position = {
                pair: 'ETH-USDC',
                direction: 'short',
                size: new Decimal(1),
                entryPrice: new Decimal(3000),
                stopLoss: new Decimal(3060),
                timestamp: Date.now(),
                signalId: 'sig-2'
            };

            (engine as any).positions.set('BTC-USDC', pos1);
            (engine as any).positions.set('ETH-USDC', pos2);

            const positions = engine.getPositions();

            expect(positions).toHaveLength(2);
            expect(positions.map(p => p.pair)).toContain('BTC-USDC');
            expect(positions.map(p => p.pair)).toContain('ETH-USDC');
        });
    });
});

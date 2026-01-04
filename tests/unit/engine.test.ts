// TradingEngine Unit Tests
// Tests for: exit signal integration, risk manager rejection, trailing stop updates

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { Decimal } from 'decimal.js';
import { TradingEngine } from '../../src/core/engine.js';
import { Candle, TradingPair, TradingSignal, Position } from '../../src/types/index.js';
import { StochasticManager } from '../../src/indicators/stochastic.js';

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
                status: 'ok',
                response: { data: { statuses: [{ resting: { oid: 12345 } }] } }
            }),
            cancelOrders: vi.fn().mockResolvedValue({}),
            getUserState: vi.fn().mockResolvedValue({
                marginSummary: { accountValue: '10000' }
            }),
            getAddress: vi.fn().mockReturnValue('0xmockaddress'),
            getOpenOrders: vi.fn().mockResolvedValue([
                { coin: 'BTC', reduceOnly: true, triggerPx: '49000' }
            ])
        },
        assetIndex: {
            getAssetIndex: vi.fn().mockReturnValue(1)
        }
    };
}

// Mock factory for SignalProcessor
function createMockSignalProcessor(checkExitsResult: TradingPair[] = [], checkExitsWithTypeResult: Array<{ pair: TradingPair; exitType: 'partial' | 'full' }> = []) {
    return {
        processCandle: vi.fn().mockReturnValue(null),
        checkExits: vi.fn().mockReturnValue(checkExitsResult),
        checkExitsWithType: vi.fn().mockReturnValue(checkExitsWithTypeResult),
        triggerCooldown: vi.fn()
    };
}

// Mock factory for RiskManager
function createMockRiskManager(canTradeResult = { allowed: true }) {
    return {
        canTrade: vi.fn().mockReturnValue(canTradeResult),
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
        it('should call checkExitsWithType for open positions', async () => {
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

            expect(mockSignalProcessor.checkExitsWithType).toHaveBeenCalledWith([
                { direction: 'long', pair: 'BTC-USDC', partialExitTaken: undefined }
            ]);
        });

        it('should close position when checkExitsWithType returns full exit', async () => {
            // Setup: open position and checkExitsWithType returning full exit
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
            mockSignalProcessor.checkExitsWithType.mockReturnValue([
                { pair: 'ETH-USDC', exitType: 'full' }
            ]);

            const candle = createCandle(Date.now(), 2900, 2950, 2880, 2890);

            await engine.handleCandle('ETH-USDC', candle);

            // Should have called placeOrder to close (reduce-only order)
            expect(mockClient.api.placeOrder).toHaveBeenCalled();
            const orderCall = mockClient.api.placeOrder.mock.calls[0];
            expect(orderCall[0][0].r).toBe(true); // reduce-only flag
        });

        it('should not process entry signals after full exit', async () => {
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

            // checkExitsWithType returns full exit
            mockSignalProcessor.checkExitsWithType.mockReturnValue([
                { pair: 'SOL-USDC', exitType: 'full' }
            ]);

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
        // Helper to set up stochastic manager with Fast K history
        function setupStochasticManager(
            engine: TradingEngine,
            pair: string,
            fastKHistory: { k: number; d: number }[]
        ) {
            const manager = new StochasticManager();
            (manager as any).fastHistory = fastKHistory.map((h, i) => ({
                k: new Decimal(h.k),
                d: new Decimal(h.d),
                timestamp: Date.now() - (fastKHistory.length - i) * 60000
            }));
            (engine as any).stochasticManagers.set(pair, manager);
        }

        it('should not update when no stochastic manager available', async () => {
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

            const candle = createCandle(Date.now(), 51000, 51100, 50900, 51000);

            await (engine as any).updateTrailingStop('BTC-USDC', candle);

            // No API calls since no stochastic manager
            expect(mockClient.api.cancelOrders).not.toHaveBeenCalled();
        });

        it('should activate trailing stop when Fast K crosses above 50 for long', async () => {
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

            // Fast K crosses from 45 to 55 (above 50)
            setupStochasticManager(engine, 'BTC-USDC', [
                { k: 45, d: 40 },
                { k: 55, d: 50 }
            ]);

            const candle = createCandle(Date.now(), 51000, 51100, 50900, 51000);

            await (engine as any).updateTrailingStop('BTC-USDC', candle);

            const updatedPosition = (engine as any).positions.get('BTC-USDC');
            expect(updatedPosition.trailingStopActivated).toBe(true);
            expect(updatedPosition.breakEvenReached).toBe(true);
        });

        it('should NOT activate when Fast K stays below 50 for long', async () => {
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

            // Fast K moves from 40 to 48 (stays below 50)
            setupStochasticManager(engine, 'BTC-USDC', [
                { k: 40, d: 35 },
                { k: 48, d: 45 }
            ]);

            const candle = createCandle(Date.now(), 51000, 51100, 50900, 51000);

            await (engine as any).updateTrailingStop('BTC-USDC', candle);

            const updatedPosition = (engine as any).positions.get('BTC-USDC');
            expect(updatedPosition.trailingStopActivated).toBe(false);
        });

        it('should activate trailing stop when Fast K crosses below 50 for short', async () => {
            const position: Position = {
                pair: 'ETH-USDC',
                direction: 'short',
                size: new Decimal(1),
                entryPrice: new Decimal(3000),
                stopLoss: new Decimal(3060),
                stopLossOrderId: 98765,
                trailingStop: new Decimal(3060),
                trailingStopActivated: false,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('ETH-USDC', position);

            // Fast K crosses from 55 to 45 (below 50)
            setupStochasticManager(engine, 'ETH-USDC', [
                { k: 55, d: 52 },
                { k: 45, d: 48 }
            ]);

            const candle = createCandle(Date.now(), 2940, 2960, 2920, 2940);

            await (engine as any).updateTrailingStop('ETH-USDC', candle);

            const updatedPosition = (engine as any).positions.get('ETH-USDC');
            expect(updatedPosition.trailingStopActivated).toBe(true);
            expect(updatedPosition.breakEvenReached).toBe(true);
        });

        it('should move stop to breakeven (entry price) on activation', async () => {
            const position: Position = {
                pair: 'BTC-USDC',
                direction: 'long',
                size: new Decimal(0.1),
                entryPrice: new Decimal(50000),
                stopLoss: new Decimal(49000),
                stopLossOrderId: 12345,
                trailingStop: new Decimal(49000),
                trailingStopActivated: false,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('BTC-USDC', position);

            // Fast K crosses above 50
            setupStochasticManager(engine, 'BTC-USDC', [
                { k: 48, d: 45 },
                { k: 52, d: 50 }
            ]);

            const candle = createCandle(Date.now(), 51000, 51100, 50900, 51000);

            await (engine as any).updateTrailingStop('BTC-USDC', candle);

            // Should cancel old and place new stop at entry price (breakeven)
            expect(mockClient.api.cancelOrders).toHaveBeenCalled();

            const updatedPosition = (engine as any).positions.get('BTC-USDC');
            // Stop should be at entry price (50000)
            expect(updatedPosition.trailingStop.toNumber()).toBe(50000);
        });

        it('should trail by ATR after breakeven is reached', async () => {
            const position: Position = {
                pair: 'SOL-USDC',
                direction: 'long',
                size: new Decimal(10),
                entryPrice: new Decimal(100),
                stopLoss: new Decimal(98),
                stopLossOrderId: 11111,
                trailingStop: new Decimal(100), // Already at breakeven
                trailingStopActivated: true,
                breakEvenReached: true,
                lastAtr: new Decimal(2), // ATR = 2
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('SOL-USDC', position);

            // Set up stochastic manager (already activated, just need history)
            setupStochasticManager(engine, 'SOL-USDC', [
                { k: 60, d: 55 },
                { k: 65, d: 60 }
            ]);

            // Price moved up significantly: new stop = 110 - 1.5*2 = 107
            const candle = createCandle(Date.now(), 110, 112, 109, 110);

            await (engine as any).updateTrailingStop('SOL-USDC', candle);

            const updatedPosition = (engine as any).positions.get('SOL-USDC');
            // Stop should trail: 110 - (1.5 * 2) = 107
            expect(updatedPosition.trailingStop.toNumber()).toBe(107);
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

    describe('Partial Exit / Scale-Out', () => {
        it('should call closePartialPosition when exitType is partial', async () => {
            const position: Position = {
                pair: 'BTC-USDC',
                direction: 'long',
                size: new Decimal(0.2),
                entryPrice: new Decimal(50000),
                stopLoss: new Decimal(49000),
                stopLossOrderId: 12345,
                partialExitTaken: false,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('BTC-USDC', position);

            // Mock checkExitsWithType to return partial exit
            mockSignalProcessor.checkExitsWithType.mockReturnValue([
                { pair: 'BTC-USDC', exitType: 'partial' }
            ]);

            const candle = createCandle(Date.now(), 51000, 51100, 50900, 51000);

            await engine.handleCandle('BTC-USDC', candle);

            // Should place partial close order (50%)
            expect(mockClient.api.placeOrder).toHaveBeenCalled();
            const orderCall = mockClient.api.placeOrder.mock.calls[0];
            expect(orderCall[0][0].r).toBe(true); // reduce-only flag
            expect(orderCall[0][0].s).toBe('0.10000000'); // 50% of 0.2

            // Should update position state
            const updatedPosition = (engine as any).positions.get('BTC-USDC');
            expect(updatedPosition.partialExitTaken).toBe(true);
            expect(updatedPosition.size.toNumber()).toBe(0.1);
        });

        it('should NOT trigger partial exit when partialExitTaken is true', async () => {
            const position: Position = {
                pair: 'BTC-USDC',
                direction: 'long',
                size: new Decimal(0.1),
                entryPrice: new Decimal(50000),
                stopLoss: new Decimal(49000),
                partialExitTaken: true, // Already taken
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('BTC-USDC', position);

            // Mock returns partial (but should be skipped since already taken)
            mockSignalProcessor.checkExitsWithType.mockReturnValue([
                { pair: 'BTC-USDC', exitType: 'partial' }
            ]);

            const candle = createCandle(Date.now(), 51000, 51100, 50900, 51000);

            await engine.handleCandle('BTC-USDC', candle);

            // Should NOT place any orders
            expect(mockClient.api.placeOrder).not.toHaveBeenCalled();
        });

        it('should cancel and resize stop loss after partial exit', async () => {
            const position: Position = {
                pair: 'SOL-USDC',
                direction: 'long',
                size: new Decimal(10),
                entryPrice: new Decimal(100),
                stopLoss: new Decimal(98),
                trailingStop: new Decimal(99),
                stopLossOrderId: 55555,
                partialExitTaken: false,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('SOL-USDC', position);

            mockSignalProcessor.checkExitsWithType.mockReturnValue([
                { pair: 'SOL-USDC', exitType: 'partial' }
            ]);

            const candle = createCandle(Date.now(), 105, 106, 104, 105);

            await engine.handleCandle('SOL-USDC', candle);

            // Should cancel old stop
            expect(mockClient.api.cancelOrders).toHaveBeenCalledWith([{ a: 1, o: 55555 }]);

            // Second placeOrder call should be the new stop loss with reduced size
            const slOrderCall = mockClient.api.placeOrder.mock.calls[1];
            expect(slOrderCall[0][0].s).toBe('5.00000000'); // 50% of 10
        });

        it('should close remaining position on full exit after partial', async () => {
            const position: Position = {
                pair: 'ETH-USDC',
                direction: 'short',
                size: new Decimal(0.5), // Remaining 50%
                entryPrice: new Decimal(3000),
                stopLoss: new Decimal(3060),
                partialExitTaken: true,
                timestamp: Date.now(),
                signalId: 'test-signal'
            };

            (engine as any).positions.set('ETH-USDC', position);

            // Full exit triggered
            mockSignalProcessor.checkExitsWithType.mockReturnValue([
                { pair: 'ETH-USDC', exitType: 'full' }
            ]);

            const candle = createCandle(Date.now(), 2890, 2910, 2880, 2890);

            await engine.handleCandle('ETH-USDC', candle);

            // Should place close order with remaining size
            expect(mockClient.api.placeOrder).toHaveBeenCalled();
            const orderCall = mockClient.api.placeOrder.mock.calls[0];
            expect(orderCall[0][0].s).toBe('0.50000000'); // Full remaining amount

            // Position should be deleted
            expect((engine as any).positions.get('ETH-USDC')).toBeUndefined();
        });
    });
});

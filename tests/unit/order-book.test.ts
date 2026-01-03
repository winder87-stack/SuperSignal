import { describe, it, expect, beforeEach } from 'vitest';
import { OrderBookManager } from '../../src/trading/order-book/manager.js';
import { OrderBookAnalyzer } from '../../src/trading/order-book/analyzer.js';
import { Level, L2Book } from '../../src/types/hyperliquid.js';
import { OrderBook, OrderBookLevel } from '../../src/trading/order-book/types.js';

describe('OrderBookManager', () => {
    let manager: OrderBookManager;

    beforeEach(() => {
        manager = new OrderBookManager();
    });

    const createLevels = (bids: [number, number][], asks: [number, number][]): [Level[], Level[]] => {
        const bidLevels: Level[] = bids.map(([px, sz]) => ({ px: px.toString(), sz: sz.toString(), n: 1 }));
        const askLevels: Level[] = asks.map(([px, sz]) => ({ px: px.toString(), sz: sz.toString(), n: 1 }));
        return [bidLevels, askLevels];
    };

    describe('updateOrderBook()', () => {
        it('should correctly update order book', () => {
            const levels = createLevels(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );

            manager.updateOrderBook('BTC', levels);

            const orderBook = manager.getOrderBook('BTC');
            expect(orderBook).toBeDefined();
            expect(orderBook?.coin).toBe('BTC');
            expect(orderBook?.bids).toHaveLength(3);
            expect(orderBook?.asks).toHaveLength(3);
            expect(orderBook?.bids[0].px).toBe('100');
            expect(orderBook?.asks[0].px).toBe('101');
        });

        it('should replace existing order book', () => {
            const levels1 = createLevels([[100, 10]], [[101, 8]]);
            const levels2 = createLevels([[105, 15]], [[106, 12]]);

            manager.updateOrderBook('BTC', levels1);
            manager.updateOrderBook('BTC', levels2);

            const orderBook = manager.getOrderBook('BTC');
            expect(orderBook?.bids[0].px).toBe('105');
            expect(orderBook?.asks[0].px).toBe('106');
        });
    });

    describe('getBestBid() and getBestAsk()', () => {
        it('should return correct best bid and ask prices', () => {
            const levels = createLevels(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );

            manager.updateOrderBook('BTC', levels);

            expect(manager.getBestBid('BTC')).toBe(100);
            expect(manager.getBestAsk('BTC')).toBe(101);
        });

        it('should return undefined for non-existent coin', () => {
            expect(manager.getBestBid('ETH')).toBeUndefined();
            expect(manager.getBestAsk('ETH')).toBeUndefined();
        });

        it('should return undefined for empty order book', () => {
            const levels = createLevels([], []);
            manager.updateOrderBook('BTC', levels);

            expect(manager.getBestBid('BTC')).toBeUndefined();
            expect(manager.getBestAsk('BTC')).toBeUndefined();
        });
    });

    describe('getMidPrice()', () => {
        it('should calculate correct mid price', () => {
            const levels = createLevels([[100, 10]], [[102, 8]]);
            manager.updateOrderBook('BTC', levels);

            expect(manager.getMidPrice('BTC')).toBe(101);
        });

        it('should return undefined for non-existent coin', () => {
            expect(manager.getMidPrice('ETH')).toBeUndefined();
        });

        it('should return undefined when bid or ask is missing', () => {
            const levels = createLevels([[100, 10]], []);
            manager.updateOrderBook('BTC', levels);

            expect(manager.getMidPrice('BTC')).toBeUndefined();
        });
    });

    describe('getTotalVolume()', () => {
        it('should calculate cumulative volume correctly for both sides', () => {
            const levels = createLevels(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );
            manager.updateOrderBook('BTC', levels);

            expect(manager.getTotalVolume('BTC', 3, 'both')).toBe(36); // 10+5+3+8+6+4
        });

        it('should calculate cumulative volume for bids only', () => {
            const levels = createLevels(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );
            manager.updateOrderBook('BTC', levels);

            expect(manager.getTotalVolume('BTC', 3, 'bid')).toBe(18); // 10+5+3
        });

        it('should calculate cumulative volume for asks only', () => {
            const levels = createLevels(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );
            manager.updateOrderBook('BTC', levels);

            expect(manager.getTotalVolume('BTC', 3, 'ask')).toBe(18); // 8+6+4
        });

        it('should limit to available depth', () => {
            const levels = createLevels(
                [[100, 10], [99, 5]],
                [[101, 8]]
            );
            manager.updateOrderBook('BTC', levels);

            expect(manager.getTotalVolume('BTC', 5, 'both')).toBe(23); // 10+5+8
        });

        it('should return 0 for non-existent coin', () => {
            expect(manager.getTotalVolume('ETH', 3, 'both')).toBe(0);
        });
    });

    describe('updateFromL2Book()', () => {
        it('should correctly process l2Book event structure', () => {
            const l2Book: L2Book = {
                coin: 'BTC',
                time: Date.now(),
                levels: createLevels(
                    [[100, 10], [99, 5]],
                    [[101, 8], [102, 6]]
                )
            };

            manager.updateFromL2Book(l2Book);

            const orderBook = manager.getOrderBook('BTC');
            expect(orderBook).toBeDefined();
            expect(orderBook?.coin).toBe('BTC');
            expect(orderBook?.bids).toHaveLength(2);
            expect(orderBook?.asks).toHaveLength(2);
        });
    });

    describe('Event emitter', () => {
        it('should emit orderBookUpdate events', () => {
            return new Promise<void>((resolve) => {
                const levels = createLevels([[100, 10]], [[101, 8]]);

                manager.on('orderBookUpdate', (event) => {
                    expect(event.coin).toBe('BTC');
                    expect(event.orderBook.bids[0].px).toBe('100');
                    expect(event.orderBook.asks[0].px).toBe('101');
                    expect(event.timestamp).toBeDefined();
                    resolve();
                });

                manager.updateOrderBook('BTC', levels);
            });
        });
    });

    describe('getCumulativeVolume()', () => {
        it('should return cumulative volumes for bids', () => {
            const levels = createLevels(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6]]
            );
            manager.updateOrderBook('BTC', levels);

            const cumulative = manager.getCumulativeVolume('BTC', 'bid');
            expect(cumulative).toEqual([10, 15, 18]);
        });

        it('should return cumulative volumes for asks', () => {
            const levels = createLevels(
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6], [103, 4]]
            );
            manager.updateOrderBook('BTC', levels);

            const cumulative = manager.getCumulativeVolume('BTC', 'ask');
            expect(cumulative).toEqual([8, 14, 18]);
        });

        it('should return empty array for non-existent coin', () => {
            const cumulative = manager.getCumulativeVolume('ETH', 'bid');
            expect(cumulative).toEqual([]);
        });
    });

    describe('hasOrderBook()', () => {
        it('should return true when order book exists', () => {
            const levels = createLevels([[100, 10]], [[101, 8]]);
            manager.updateOrderBook('BTC', levels);

            expect(manager.hasOrderBook('BTC')).toBe(true);
        });

        it('should return false when order book does not exist', () => {
            expect(manager.hasOrderBook('ETH')).toBe(false);
        });
    });

    describe('getAvailableCoins()', () => {
        it('should return array of coin symbols', () => {
            const levels1 = createLevels([[100, 10]], [[101, 8]]);
            const levels2 = createLevels([[2000, 5]], [[2005, 3]]);

            manager.updateOrderBook('BTC', levels1);
            manager.updateOrderBook('ETH', levels2);

            const coins = manager.getAvailableCoins();
            expect(coins).toHaveLength(2);
            expect(coins).toContain('BTC');
            expect(coins).toContain('ETH');
        });

        it('should return empty array when no order books', () => {
            const coins = manager.getAvailableCoins();
            expect(coins).toEqual([]);
        });
    });

    describe('clearOrderBook()', () => {
        it('should clear order book for specific coin', () => {
            const levels = createLevels([[100, 10]], [[101, 8]]);
            manager.updateOrderBook('BTC', levels);

            manager.clearOrderBook('BTC');

            expect(manager.hasOrderBook('BTC')).toBe(false);
        });
    });

    describe('clearAllOrderBooks()', () => {
        it('should clear all order books', () => {
            const levels1 = createLevels([[100, 10]], [[101, 8]]);
            const levels2 = createLevels([[2000, 5]], [[2005, 3]]);

            manager.updateOrderBook('BTC', levels1);
            manager.updateOrderBook('ETH', levels2);

            manager.clearAllOrderBooks();

            expect(manager.getAvailableCoins()).toHaveLength(0);
        });
    });
});

describe('OrderBookAnalyzer', () => {
    let analyzer: OrderBookAnalyzer;

    beforeEach(() => {
        analyzer = new OrderBookAnalyzer();
    });

    const createOrderBook = (
        bids: [number, number][],
        asks: [number, number][],
        coin: string = 'BTC'
    ): OrderBook => ({
        bids: bids.map(([px, sz]) => ({ px: px.toString(), sz: sz.toString(), n: 1 })),
        asks: asks.map(([px, sz]) => ({ px: px.toString(), sz: sz.toString(), n: 1 })),
        timestamp: Date.now(),
        coin
    });

    describe('calculateSpread()', () => {
        it('should correctly calculate bid-ask spread (absolute and percentage)', () => {
            const orderBook = createOrderBook([[100, 10]], [[102, 8]]);

            const spread = analyzer.calculateSpread(orderBook);

            expect(spread).toBeDefined();
            expect(spread?.absolute).toBe(2);
            expect(spread?.percentage).toBeCloseTo(1.9802, 2); // 2 / 101 * 100
        });

        it('should return undefined for empty order book', () => {
            const orderBook = createOrderBook([], []);

            const spread = analyzer.calculateSpread(orderBook);

            expect(spread).toBeUndefined();
        });

        it('should return undefined when bids are empty', () => {
            const orderBook = createOrderBook([], [[102, 8]]);

            const spread = analyzer.calculateSpread(orderBook);

            expect(spread).toBeUndefined();
        });

        it('should return undefined when asks are empty', () => {
            const orderBook = createOrderBook([[100, 10]], []);

            const spread = analyzer.calculateSpread(orderBook);

            expect(spread).toBeUndefined();
        });
    });

    describe('estimateSlippage()', () => {
        it('should correctly estimate slippage for buy order', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 5], [102, 6], [103, 4]]
            );

            const estimate = analyzer.estimateSlippage(orderBook, 10, 'buy');

            expect(estimate.estimatedSlippage).toBeGreaterThan(0);
            expect(estimate.liquidityAvailable).toBe(10);
            expect(estimate.recommendedOrderSize).toBeGreaterThan(0);
            expect(estimate.marketImpactScore).toBeGreaterThan(0);
            expect(estimate.marketImpactScore).toBeLessThanOrEqual(1);
        });

        it('should correctly estimate slippage for sell order', () => {
            const orderBook = createOrderBook(
                [[100, 5], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );

            const estimate = analyzer.estimateSlippage(orderBook, 10, 'sell');

            expect(estimate.estimatedSlippage).toBeGreaterThan(0);
            expect(estimate.liquidityAvailable).toBe(10);
            expect(estimate.recommendedOrderSize).toBeGreaterThan(0);
        });

        it('should return 100% slippage for empty order book', () => {
            const orderBook = createOrderBook([], []);

            const estimate = analyzer.estimateSlippage(orderBook, 5, 'buy');

            expect(estimate.estimatedSlippage).toBe(100);
            expect(estimate.liquidityAvailable).toBe(0);
            expect(estimate.recommendedOrderSize).toBe(0);
            expect(estimate.marketImpactScore).toBe(1);
        });

        it('should estimate higher slippage for larger orders', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );

            const smallOrder = analyzer.estimateSlippage(orderBook, 1, 'buy');
            const largeOrder = analyzer.estimateSlippage(orderBook, 10, 'buy');

            expect(largeOrder.estimatedSlippage).toBeGreaterThan(smallOrder.estimatedSlippage);
        });

        it('should estimate higher slippage for orders that consume multiple levels', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 5], [102, 5], [103, 5]]
            );

            const estimate = analyzer.estimateSlippage(orderBook, 8, 'buy');

            expect(estimate.estimatedSlippage).toBeGreaterThan(0);
            expect(estimate.liquidityAvailable).toBe(8);
        });
    });

    describe('calculateLiquidityDepth()', () => {
        it('should correctly calculate cumulative volume at N levels', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );

            const depth = analyzer.calculateLiquidityDepth(orderBook, 3);

            expect(depth.bidVolume).toBe(18); // 10+5+3
            expect(depth.askVolume).toBe(18); // 8+6+4
        });

        it('should limit to available levels', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5]],
                [[101, 8]]
            );

            const depth = analyzer.calculateLiquidityDepth(orderBook, 5);

            expect(depth.bidVolume).toBe(15); // 10+5
            expect(depth.askVolume).toBe(8);
        });

        it('should return 0 for empty order book', () => {
            const orderBook = createOrderBook([], []);

            const depth = analyzer.calculateLiquidityDepth(orderBook, 3);

            expect(depth.bidVolume).toBe(0);
            expect(depth.askVolume).toBe(0);
        });
    });

    describe('identifyHighLiquidityZones()', () => {
        it('should correctly identify high volume concentration', () => {
            const orderBook = createOrderBook(
                [[100, 50], [99, 5], [98, 5]], // 50 is 83.3% of 60
                [[101, 40], [102, 5], [103, 5]] // 40 is 80% of 50
            );

            const zones = analyzer.identifyHighLiquidityZones(orderBook, 0.5); // 50% threshold

            expect(zones.length).toBeGreaterThan(0);
            expect(zones.some(z => z.price === 100 && z.volume === 50)).toBe(true);
            expect(zones.some(z => z.price === 101 && z.volume === 40)).toBe(true);
        });

        it('should return empty array when no zones meet threshold', () => {
            const orderBook = createOrderBook(
                [[100, 5], [99, 5], [98, 5]],
                [[101, 5], [102, 5], [103, 5]]
            );

            const zones = analyzer.identifyHighLiquidityZones(orderBook, 0.5); // 50% threshold

            expect(zones).toHaveLength(0);
        });

        it('should sort zones by volume percentage descending', () => {
            const orderBook = createOrderBook(
                [[100, 50], [99, 30], [98, 20]],
                [[101, 40], [102, 25], [103, 15]]
            );

            const zones = analyzer.identifyHighLiquidityZones(orderBook, 0.2);

            for (let i = 0; i < zones.length - 1; i++) {
                expect(zones[i].volumePercentage).toBeGreaterThanOrEqual(zones[i + 1].volumePercentage);
            }
        });
    });

    describe('isThinMarket()', () => {
        it('should correctly identify thin markets', () => {
            const orderBook = createOrderBook(
                [[100, 0.5], [99, 0.3]],
                [[101, 0.4], [102, 0.2]]
            );

            const isThin = analyzer.isThinMarket(orderBook, 1.0);

            expect(isThin).toBe(true);
        });

        it('should return false for liquid markets', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            const isThin = analyzer.isThinMarket(orderBook, 1.0);

            expect(isThin).toBe(false);
        });

        it('should use custom threshold', () => {
            const orderBook = createOrderBook(
                [[100, 5], [99, 3]],
                [[101, 4], [102, 2]]
            );

            const isThinLow = analyzer.isThinMarket(orderBook, 20.0);
            const isThinHigh = analyzer.isThinMarket(orderBook, 5.0);

            expect(isThinLow).toBe(true);
            expect(isThinHigh).toBe(false);
        });
    });

    describe('calculateExecutionParameters()', () => {
        it('should return appropriate execution parameters for buy', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            const params = analyzer.calculateExecutionParameters(orderBook, 5, 'buy', 0.5);

            expect(params.limitPrice).toBeGreaterThan(101);
            expect(params.orderSize).toBeGreaterThan(0);
            expect(params.slippageTolerance).toBe(0.5);
            expect(params.liquidityThreshold).toBeGreaterThan(0);
        });

        it('should return appropriate execution parameters for sell', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            const params = analyzer.calculateExecutionParameters(orderBook, 5, 'sell', 0.5);

            expect(params.limitPrice).toBeLessThan(100);
            expect(params.orderSize).toBeGreaterThan(0);
            expect(params.slippageTolerance).toBe(0.5);
            expect(params.liquidityThreshold).toBeGreaterThan(0);
        });

        it('should adjust order size when slippage exceeds tolerance', () => {
            const orderBook = createOrderBook(
                [[100, 1], [99, 1]],
                [[101, 1], [102, 1]]
            );

            const params = analyzer.calculateExecutionParameters(orderBook, 10, 'buy', 0.1);

            // Order size should be reduced to recommended size
            expect(params.orderSize).toBeLessThan(10);
        });

        it('should return zero values for empty order book', () => {
            const orderBook = createOrderBook([], []);

            const params = analyzer.calculateExecutionParameters(orderBook, 5, 'buy', 0.5);

            expect(params.limitPrice).toBe(0);
            expect(params.orderSize).toBe(0);
            expect(params.liquidityThreshold).toBe(0);
        });
    });

    describe('calculateMetrics()', () => {
        it('should return comprehensive order book metrics', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5], [98, 3]],
                [[102, 8], [101, 6], [103, 4]]
            );

            const metrics = analyzer.calculateMetrics(orderBook);

            expect(metrics).toBeDefined();
            expect(metrics?.bidAskSpread).toBe(2);
            expect(metrics?.bidAskSpreadPercentage).toBeCloseTo(1.9802, 2);
            expect(metrics?.bestBidPrice).toBe(100);
            expect(metrics?.bestAskPrice).toBe(102);
            expect(metrics?.totalBidVolume).toBe(18);
            expect(metrics?.totalAskVolume).toBe(18);
            expect(metrics?.midPrice).toBe(101);
            expect(metrics?.liquidityDepth).toBeInstanceOf(Map);
            expect(metrics?.liquidityDepth.size).toBe(10);
        });

        it('should return undefined for empty order book', () => {
            const orderBook = createOrderBook([], []);

            const metrics = analyzer.calculateMetrics(orderBook);

            expect(metrics).toBeUndefined();
        });

        it('should calculate liquidity depth at different levels', () => {
            const orderBook = createOrderBook(
                [[100, 10], [99, 5], [98, 3]],
                [[102, 8], [101, 6], [103, 4]]
            );

            const metrics = analyzer.calculateMetrics(orderBook);

            expect(metrics?.liquidityDepth.get(1)).toBe(18); // 10+8
            expect(metrics?.liquidityDepth.get(2)).toBe(29); // 10+5+8+6
            expect(metrics?.liquidityDepth.get(3)).toBe(36); // 10+5+3+8+6+4
        });
    });
});

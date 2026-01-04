import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HyperliquidSuperSignal } from '../../src/index.js';
import { L2Book } from '../../src/types/hyperliquid.js';
import { OrderBookMetrics } from '../../src/trading/order-book/types.js';

// Valid test private key (0x... format, 64 hex chars)
const TEST_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('Order Book Integration with src/index.ts', () => {
    let bot: HyperliquidSuperSignal;

    beforeEach(() => {
        // Set a valid test private key for testing
        process.env.HL_WALLET_PRIVATE_KEY = TEST_PRIVATE_KEY;
        // Create a new bot instance for each test
        bot = new HyperliquidSuperSignal();
    });

    afterEach(async () => {
        await bot.stop();
    });

    const createL2Book = (
        coin: string,
        bids: [number, number][],
        asks: [number, number][]
    ): L2Book => ({
        coin,
        time: Date.now(),
        levels: [
            bids.map(([px, sz]) => ({ px: px.toString(), sz: sz.toString(), n: 1 })),
            asks.map(([px, sz]) => ({ px: px.toString(), sz: sz.toString(), n: 1 }))
        ]
    });

    describe('l2Book events processing', () => {
        it('should correctly process l2Book events', () => {
            // Access private members via type assertion for testing
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5], [98, 3]],
                [[101, 8], [102, 6], [103, 4]]
            );

            // Simulate l2Book event
            botAny.orderBookManager.updateFromL2Book(l2Book);

            // Verify order book was updated
            const orderBook = botAny.orderBookManager.getOrderBook('BTC');
            expect(orderBook).toBeDefined();
            expect(orderBook?.coin).toBe('BTC');
            expect(orderBook?.bids).toHaveLength(3);
            expect(orderBook?.asks).toHaveLength(3);
            expect(orderBook?.bids[0].px).toBe('100');
            expect(orderBook?.asks[0].px).toBe('101');
        });

        it('should handle multiple l2Book events for different coins', () => {
            const botAny = bot as any;

            const btcBook = createL2Book('BTC', [[100, 10]], [[101, 8]]);
            const ethBook = createL2Book('ETH', [[2000, 5]], [[2005, 3]]);

            botAny.orderBookManager.updateFromL2Book(btcBook);
            botAny.orderBookManager.updateFromL2Book(ethBook);

            expect(botAny.orderBookManager.hasOrderBook('BTC')).toBe(true);
            expect(botAny.orderBookManager.hasOrderBook('ETH')).toBe(true);
            expect(botAny.orderBookManager.getBestBid('BTC')).toBe(100);
            expect(botAny.orderBookManager.getBestBid('ETH')).toBe(2000);
        });

        it('should update existing order book with new data', () => {
            const botAny = bot as any;

            const book1 = createL2Book('BTC', [[100, 10]], [[101, 8]]);
            const book2 = createL2Book('BTC', [[105, 15]], [[106, 12]]);

            botAny.orderBookManager.updateFromL2Book(book1);
            botAny.orderBookManager.updateFromL2Book(book2);

            expect(botAny.orderBookManager.getBestBid('BTC')).toBe(105);
            expect(botAny.orderBookManager.getBestAsk('BTC')).toBe(106);
        });
    });

    describe('Order book metrics storage and update', () => {
        it('should store and update order book metrics', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[102, 8], [101, 6]]
            );

            // Update order book
            botAny.orderBookManager.updateFromL2Book(l2Book);

            // Get order book and calculate metrics
            const orderBook = botAny.orderBookManager.getOrderBook('BTC');
            expect(orderBook).toBeDefined();

            const metrics = botAny.orderBookAnalyzer.calculateMetrics(orderBook);
            expect(metrics).toBeDefined();

            // Store metrics
            botAny.engine.orderBookMetrics.set('BTC', metrics);

            // Verify metrics are stored
            const storedMetrics = botAny.engine.orderBookMetrics.get('BTC');
            expect(storedMetrics).toBeDefined();
            expect(storedMetrics?.bestBidPrice).toBe(100);
            expect(storedMetrics?.bestAskPrice).toBe(102);
            expect(storedMetrics?.midPrice).toBe(101);
            expect(storedMetrics?.bidAskSpread).toBe(2);
            expect(storedMetrics?.totalBidVolume).toBe(15);
            expect(storedMetrics?.totalAskVolume).toBe(14);
        });

        it('should update metrics when order book changes', () => {
            const botAny = bot as any;

            const book1 = createL2Book('BTC', [[100, 10]], [[101, 8]]);
            const book2 = createL2Book('BTC', [[105, 15]], [[106, 12]]);

            // First update
            botAny.orderBookManager.updateFromL2Book(book1);
            let orderBook = botAny.orderBookManager.getOrderBook('BTC');
            let metrics = botAny.orderBookAnalyzer.calculateMetrics(orderBook);
            botAny.engine.orderBookMetrics.set('BTC', metrics);

            expect(botAny.engine.orderBookMetrics.get('BTC')?.bestBidPrice).toBe(100);

            // Second update
            botAny.orderBookManager.updateFromL2Book(book2);
            orderBook = botAny.orderBookManager.getOrderBook('BTC');
            metrics = botAny.orderBookAnalyzer.calculateMetrics(orderBook);
            botAny.engine.orderBookMetrics.set('BTC', metrics);

            expect(botAny.engine.orderBookMetrics.get('BTC')?.bestBidPrice).toBe(105);
        });

        it('should store metrics for multiple coins', () => {
            const botAny = bot as any;

            const btcBook = createL2Book('BTC', [[100, 10]], [[101, 8]]);
            const ethBook = createL2Book('ETH', [[2000, 5]], [[2005, 3]]);

            botAny.orderBookManager.updateFromL2Book(btcBook);
            botAny.orderBookManager.updateFromL2Book(ethBook);

            const btcOrderBook = botAny.orderBookManager.getOrderBook('BTC');
            const ethOrderBook = botAny.orderBookManager.getOrderBook('ETH');

            const btcMetrics = botAny.orderBookAnalyzer.calculateMetrics(btcOrderBook);
            const ethMetrics = botAny.orderBookAnalyzer.calculateMetrics(ethOrderBook);

            botAny.engine.orderBookMetrics.set('BTC', btcMetrics);
            botAny.engine.orderBookMetrics.set('ETH', ethMetrics);

            expect(botAny.engine.orderBookMetrics.size).toBe(2);
            expect(botAny.engine.orderBookMetrics.get('BTC')?.bestBidPrice).toBe(100);
            expect(botAny.engine.orderBookMetrics.get('ETH')?.bestBidPrice).toBe(2000);
        });
    });

    describe('getExecutionParameters()', () => {
        it('should return correct execution parameters for buy', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const params = botAny.engine.getExecutionParameters('BTC', 5, 'buy');

            expect(params.limitPrice).toBeGreaterThan(0);
            expect(params.orderSize).toBeGreaterThan(0);
            expect(params.slippageTolerance).toBeGreaterThan(0);
            expect(params.liquidityThreshold).toBeGreaterThan(0);
        });

        it('should return correct execution parameters for sell', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const params = botAny.engine.getExecutionParameters('BTC', 5, 'sell');

            expect(params.limitPrice).toBeGreaterThan(0);
            expect(params.orderSize).toBeGreaterThan(0);
            expect(params.slippageTolerance).toBeGreaterThan(0);
            expect(params.liquidityThreshold).toBeGreaterThan(0);
        });

        it('should return default parameters when no order book exists', () => {
            const params = (bot as any).engine.getExecutionParameters('BTC', 5, 'buy');

            expect(params.limitPrice).toBe(0);
            expect(params.orderSize).toBe(5);
            expect(params.slippageTolerance).toBe(0.001);
            expect(params.liquidityThreshold).toBe(1000);
        });

        it('should adjust slippage tolerance for thin markets', () => {
            const botAny = bot as any;

            // Create a thin market (low volume)
            const l2Book = createL2Book(
                'BTC',
                [[100, 0.5], [99, 0.3]],
                [[101, 0.4], [102, 0.2]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const params = botAny.engine.getExecutionParameters('BTC', 5, 'buy');

            // Thin market should have higher slippage tolerance
            expect(params.slippageTolerance).toBeGreaterThan(0.001);
        });

        it('should adjust limit price based on best bid/ask', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const buyParams = botAny.engine.getExecutionParameters('BTC', 5, 'buy');
            const sellParams = botAny.engine.getExecutionParameters('BTC', 5, 'sell');

            // Buy limit price should be near best ask
            expect(buyParams.limitPrice).toBeLessThan(101);
            // Sell limit price should be near best bid
            expect(sellParams.limitPrice).toBeGreaterThan(100);
        });
    });

    describe('estimateSlippage()', () => {
        it('should return correct slippage estimates for buy', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const orderBook = botAny.orderBookManager.getOrderBook('BTC');
            const estimate = (bot as any).orderBookAnalyzer.estimateSlippage(orderBook, 5, 'buy');

            expect(estimate.estimatedSlippage).toBeGreaterThanOrEqual(0);
            expect(estimate.liquidityAvailable).toBe(5);
            expect(estimate.recommendedOrderSize).toBeGreaterThan(0);
            expect(estimate.marketImpactScore).toBeGreaterThanOrEqual(0);
            expect(estimate.marketImpactScore).toBeLessThanOrEqual(1);
        });

        it('should return correct slippage estimates for sell', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const orderBook = botAny.orderBookManager.getOrderBook('BTC');
            const estimate = (bot as any).orderBookAnalyzer.estimateSlippage(orderBook, 5, 'sell');

            expect(estimate.estimatedSlippage).toBeGreaterThanOrEqual(0);
            expect(estimate.liquidityAvailable).toBe(5);
            expect(estimate.recommendedOrderSize).toBeGreaterThan(0);
        });

        it('should return default values when no order book exists', () => {
            const botAny = bot as any;
            const estimate = botAny.orderBookAnalyzer.estimateSlippage(undefined, 5, 'buy');

            expect(estimate.estimatedSlippage).toBe(100);
            expect(estimate.liquidityAvailable).toBe(0);
            expect(estimate.recommendedOrderSize).toBe(0);
            expect(estimate.marketImpactScore).toBe(1);
        });

        it('should estimate higher slippage for larger orders', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const orderBook = botAny.orderBookManager.getOrderBook('BTC');
            const smallOrder = (bot as any).orderBookAnalyzer.estimateSlippage(orderBook, 1, 'buy');
            const largeOrder = (bot as any).orderBookAnalyzer.estimateSlippage(orderBook, 10, 'buy');

            expect(largeOrder.estimatedSlippage).toBeGreaterThan(smallOrder.estimatedSlippage);
        });
    });

    describe('identifyOptimalEntryExit()', () => {
        it('should return correct entry/exit points for buy', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const result = botAny.engine.identifyOptimalEntryExit('BTC', 'buy');

            expect(result.entryPrice).toBe(101); // Best ask
            expect(result.exitPrice).toBeGreaterThanOrEqual(result.entryPrice);
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThanOrEqual(1);
        });

        it('should return correct entry/exit points for sell', () => {
            const botAny = bot as any;

            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [102, 6]]
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const result = botAny.engine.identifyOptimalEntryExit('BTC', 'sell');

            expect(result.entryPrice).toBe(100); // Best bid
            expect(result.exitPrice).toBeLessThanOrEqual(result.entryPrice);
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThanOrEqual(1);
        });

        it('should return default values when no order book exists', () => {
            const botAny = bot as any;
            const result = botAny.engine.identifyOptimalEntryExit('BTC', 'buy');

            expect(result.entryPrice).toBe(0);
            expect(result.exitPrice).toBe(0);
            expect(result.confidence).toBe(0);
        });

        it('should use high liquidity zones for exit price', () => {
            const botAny = bot as any;

            // Create order book with high liquidity zone at 105
            const l2Book = createL2Book(
                'BTC',
                [[100, 10], [99, 5]],
                [[101, 8], [105, 50], [102, 6]] // 105 has high volume
            );

            botAny.orderBookManager.updateFromL2Book(l2Book);

            const result = botAny.engine.identifyOptimalEntryExit('BTC', 'buy');

            // Exit should be at or near the high liquidity zone
            expect(result.exitPrice).toBeGreaterThanOrEqual(101);
        });

        it('should calculate confidence based on liquidity and spread', () => {
            const botAny = bot as any;

            // High liquidity, tight spread
            const liquidBook = createL2Book(
                'BTC',
                [[100, 1000], [99, 500]],
                [[100.5, 1000], [101, 500]]
            );

            botAny.orderBookManager.updateFromL2Book(liquidBook);
            // Update metrics for liquid book
            const liquidOrderBook = botAny.orderBookManager.getOrderBook('BTC');
            const liquidMetrics = botAny.orderBookAnalyzer.calculateMetrics(liquidOrderBook);
            botAny.engine.orderBookMetrics.set('BTC', liquidMetrics);
            const liquidResult = (bot as any).engine.identifyOptimalEntryExit('BTC', 'buy');

            // Low liquidity, wide spread
            const thinBook = createL2Book(
                'BTC',
                [[100, 1], [99, 0.5]],
                [[105, 1], [106, 0.5]]
            );

            botAny.orderBookManager.updateFromL2Book(thinBook);
            // Update metrics for thin book
            const thinOrderBook = botAny.orderBookManager.getOrderBook('BTC');
            const thinMetrics = botAny.orderBookAnalyzer.calculateMetrics(thinOrderBook);
            botAny.engine.orderBookMetrics.set('BTC', thinMetrics);
            const thinResult = (bot as any).engine.identifyOptimalEntryExit('BTC', 'buy');

            // Liquid market should have higher confidence
            expect(liquidResult.confidence).toBeGreaterThan(thinResult.confidence);
        });
    });

    describe('Thin market detection in signal processing', () => {
        it('should detect thin markets correctly', () => {
            const botAny = bot as any;

            // Create a thin market (low volume)
            const thinBook = createL2Book(
                'BTC',
                [[100, 0.5], [99, 0.3]],
                [[101, 0.4], [102, 0.2]]
            );

            botAny.orderBookManager.updateFromL2Book(thinBook);

            const orderBook = botAny.orderBookManager.getOrderBook('BTC');
            const isThin = botAny.orderBookAnalyzer.isThinMarket(orderBook, 1000);

            expect(isThin).toBe(true);
        });

        it('should not detect liquid markets as thin', () => {
            const botAny = bot as any;

            // Create a liquid market (high volume)
            const liquidBook = createL2Book(
                'BTC',
                [[100, 1000], [99, 500]],
                [[101, 800], [102, 600]]
            );

            botAny.orderBookManager.updateFromL2Book(liquidBook);

            const orderBook = botAny.orderBookManager.getOrderBook('BTC');
            const isThin = botAny.orderBookAnalyzer.isThinMarket(orderBook, 1000);

            expect(isThin).toBe(false);
        });

        it('should use configurable threshold for thin market detection', () => {
            const botAny = bot as any;

            const book = createL2Book(
                'BTC',
                [[100, 500], [99, 300]],
                [[101, 400], [102, 200]]
            );

            botAny.orderBookManager.updateFromL2Book(book);

            const orderBook = botAny.orderBookManager.getOrderBook('BTC');

            // With low threshold, market is not thin
            const isThinLow = botAny.orderBookAnalyzer.isThinMarket(orderBook, 100);
            expect(isThinLow).toBe(false);

            // With high threshold, market is thin
            const isThinHigh = botAny.orderBookAnalyzer.isThinMarket(orderBook, 5000);
            expect(isThinHigh).toBe(true);
        });

        it('should adjust execution parameters for thin markets', () => {
            const botAny = bot as any;

            const thinBook = createL2Book(
                'BTC',
                [[100, 0.5], [99, 0.3]],
                [[101, 0.4], [102, 0.2]]
            );

            botAny.orderBookManager.updateFromL2Book(thinBook);

            const params = botAny.engine.getExecutionParameters('BTC', 5, 'buy');

            // Thin market should have higher slippage tolerance
            expect(params.slippageTolerance).toBeGreaterThan(0.001);
        });
    });

    describe('Event listener integration', () => {
        it('should emit orderBookUpdate events', () => {
            const botAny = bot as any;

            return new Promise<void>((resolve) => {
                const l2Book = createL2Book('BTC', [[100, 10]], [[101, 8]]);

                botAny.orderBookManager.on('orderBookUpdate', (event: any) => {
                    expect(event.coin).toBe('BTC');
                    expect(event.orderBook.bids[0].px).toBe('100');
                    expect(event.orderBook.asks[0].px).toBe('101');
                    resolve();
                });

                botAny.orderBookManager.updateFromL2Book(l2Book);
            });
        });

        it('should update metrics on orderBookUpdate event', () => {
            const botAny = bot as any;

            return new Promise<void>((resolve) => {
                const l2Book = createL2Book('BTC', [[100, 10]], [[101, 8]]);

                botAny.orderBookManager.on('orderBookUpdate', (event: any) => {
                    const metrics = botAny.orderBookAnalyzer.calculateMetrics(event.orderBook);
                    botAny.engine.orderBookMetrics.set(event.coin, metrics);

                    const storedMetrics = botAny.engine.orderBookMetrics.get('BTC');
                    expect(storedMetrics).toBeDefined();
                    expect(storedMetrics?.bestBidPrice).toBe(100);
                    resolve();
                });

                botAny.orderBookManager.updateFromL2Book(l2Book);
            });
        });
    });

    describe('getStatus()', () => {
        it('should return correct bot status', () => {
            const status = bot.getStatus();

            expect(status.running).toBe(false); // Not started
            expect(status.pairs).toBeInstanceOf(Array);
            expect(status.version).toBe('1.0.0');
        });
    });
});

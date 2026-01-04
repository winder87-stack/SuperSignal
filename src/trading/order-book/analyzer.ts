import {
    OrderBook,
    OrderBookMetrics,
    SlippageEstimate,
    ExecutionParameters,
    LiquidityZone,
} from './types.js';

/**
 * OrderBookAnalyzer - Analyzes order book data to calculate metrics,
 * estimate slippage, and determine execution parameters
 */
export class OrderBookAnalyzer {
    /**
     * Calculate bid-ask spread (absolute and percentage)
     * @param orderBook - Order book to analyze
     * @returns Spread metrics or undefined if insufficient data
     */
    calculateSpread(orderBook: OrderBook): {
        absolute: number;
        percentage: number;
    } | undefined {
        if (orderBook.bids.length === 0 || orderBook.asks.length === 0) {
            return undefined;
        }

        const bestBid = parseFloat(orderBook.bids[0].px);
        const bestAsk = parseFloat(orderBook.asks[0].px);
        const midPrice = (bestBid + bestAsk) / 2;

        const absoluteSpread = bestAsk - bestBid;
        const percentageSpread = (absoluteSpread / midPrice) * 100;

        return {
            absolute: absoluteSpread,
            percentage: percentageSpread,
        };
    }

    /**
     * Estimate slippage for a given order size and side
     * Walks through order book levels to find where order would be filled
     * @param orderBook - Order book to analyze
     * @param orderSize - Size of the order to estimate slippage for
     * @param side - 'buy' or 'sell'
     * @returns Slippage estimate
     */
    estimateSlippage(
        orderBook: OrderBook,
        orderSize: number,
        side: 'buy' | 'sell'
    ): SlippageEstimate {
        if (!orderBook) {
            return {
                estimatedSlippage: 100, // 100% slippage - no liquidity
                liquidityAvailable: 0,
                recommendedOrderSize: 0,
                marketImpactScore: 1,
            };
        }
        const levels = side === 'buy' ? orderBook.asks : orderBook.bids;

        if (levels.length === 0) {
            return {
                estimatedSlippage: 100, // 100% slippage - no liquidity
                liquidityAvailable: 0,
                recommendedOrderSize: 0,
                marketImpactScore: 1,
            };
        }

        const bestPrice = parseFloat(levels[0].px);
        let remainingSize = orderSize;
        let totalCost = 0;
        let totalVolume = 0;
        let _levelsConsumed = 0;

        // Walk through order book levels
        for (const level of levels) {
            const levelPrice = parseFloat(level.px);
            const levelSize = parseFloat(level.sz);

            if (remainingSize <= 0) {
                break;
            }

            const sizeToConsume = Math.min(remainingSize, levelSize);
            totalCost += sizeToConsume * levelPrice;
            totalVolume += sizeToConsume;
            remainingSize -= sizeToConsume;
            _levelsConsumed++;
        }

        // Calculate weighted average price
        const weightedAvgPrice = totalVolume > 0 ? totalCost / totalVolume : bestPrice;

        // Calculate slippage percentage
        const slippage =
            side === 'buy'
                ? ((weightedAvgPrice - bestPrice) / bestPrice) * 100
                : ((bestPrice - weightedAvgPrice) / bestPrice) * 100;

        // Calculate market impact score (0-1)
        // Higher score means more impact on the market
        const totalLiquidity = this.calculateTotalVolume(orderBook, side);
        const marketImpactScore = totalLiquidity > 0 ? orderSize / totalLiquidity : 1;

        // Recommend order size based on liquidity (max 10% of total liquidity)
        const recommendedOrderSize = totalLiquidity * 0.1;

        return {
            estimatedSlippage: Math.max(0, slippage),
            liquidityAvailable: totalVolume,
            recommendedOrderSize,
            marketImpactScore: Math.min(1, marketImpactScore),
        };
    }

    /**
     * Calculate cumulative volume at N price levels
     * @param orderBook - Order book to analyze
     * @param priceLevels - Number of price levels to include
     * @returns Cumulative volume for bids and asks
     */
    calculateLiquidityDepth(
        orderBook: OrderBook,
        priceLevels: number
    ): { bidVolume: number; askVolume: number } {
        const bidDepth = Math.min(priceLevels, orderBook.bids.length);
        const askDepth = Math.min(priceLevels, orderBook.asks.length);

        let bidVolume = 0;
        let askVolume = 0;

        for (let i = 0; i < bidDepth; i++) {
            bidVolume += parseFloat(orderBook.bids[i].sz);
        }

        for (let i = 0; i < askDepth; i++) {
            askVolume += parseFloat(orderBook.asks[i].sz);
        }

        return { bidVolume, askVolume };
    }

    /**
     * Identify price levels with high volume concentration
     * @param orderBook - Order book to analyze
     * @param threshold - Volume threshold as percentage of total (default: 0.05 = 5%)
     * @returns Array of high liquidity zones
     */
    identifyHighLiquidityZones(
        orderBook: OrderBook,
        threshold: number = 0.05
    ): LiquidityZone[] {
        const zones: LiquidityZone[] = [];

        // Calculate total volume for bids and asks
        const totalBidVolume = orderBook.bids.reduce(
            (sum, level) => sum + parseFloat(level.sz),
            0
        );
        const totalAskVolume = orderBook.asks.reduce(
            (sum, level) => sum + parseFloat(level.sz),
            0
        );

        // Check bid levels
        for (const level of orderBook.bids) {
            const volume = parseFloat(level.sz);
            const volumePercentage = totalBidVolume > 0 ? volume / totalBidVolume : 0;

            if (volumePercentage >= threshold) {
                zones.push({
                    price: parseFloat(level.px),
                    volume,
                    volumePercentage,
                });
            }
        }

        // Check ask levels
        for (const level of orderBook.asks) {
            const volume = parseFloat(level.sz);
            const volumePercentage = totalAskVolume > 0 ? volume / totalAskVolume : 0;

            if (volumePercentage >= threshold) {
                zones.push({
                    price: parseFloat(level.px),
                    volume,
                    volumePercentage,
                });
            }
        }

        // Sort by volume percentage descending
        zones.sort((a, b) => b.volumePercentage - a.volumePercentage);

        return zones;
    }

    /**
     * Check if market has insufficient liquidity
     * @param orderBook - Order book to analyze
     * @param threshold - Minimum volume threshold (default: 1.0)
     * @returns True if market is thin
     */
    isThinMarket(orderBook: OrderBook, threshold: number = 1.0): boolean {
        const totalBidVolume = orderBook.bids.reduce(
            (sum, level) => sum + parseFloat(level.sz),
            0
        );
        const totalAskVolume = orderBook.asks.reduce(
            (sum, level) => sum + parseFloat(level.sz),
            0
        );

        return totalBidVolume < threshold || totalAskVolume < threshold;
    }

    /**
     * Calculate execution parameters adjusted for slippage and liquidity
     * @param orderBook - Order book to analyze
     * @param orderSize - Desired order size
     * @param side - 'buy' or 'sell'
     * @param slippageTolerance - Maximum acceptable slippage percentage
     * @returns Execution parameters
     */
    calculateExecutionParameters(
        orderBook: OrderBook,
        orderSize: number,
        side: 'buy' | 'sell',
        slippageTolerance: number
    ): ExecutionParameters {
        const levels = side === 'buy' ? orderBook.asks : orderBook.bids;

        if (levels.length === 0) {
            return {
                limitPrice: 0,
                orderSize: 0,
                slippageTolerance,
                liquidityThreshold: 0,
            };
        }

        const bestPrice = parseFloat(levels[0].px);
        const slippageEstimate = this.estimateSlippage(orderBook, orderSize, side);

        // Adjust order size if slippage exceeds tolerance
        let adjustedOrderSize = orderSize;
        if (slippageEstimate.estimatedSlippage > slippageTolerance) {
            // Reduce order size to stay within tolerance
            adjustedOrderSize = slippageEstimate.recommendedOrderSize;
        }

        // Calculate limit price adjusted for slippage
        const limitPrice =
            side === 'buy'
                ? bestPrice * (1 + slippageTolerance / 100)
                : bestPrice * (1 - slippageTolerance / 100);

        // Set liquidity threshold (minimum volume required)
        const liquidityThreshold = adjustedOrderSize * 2; // Require 2x order size

        return {
            limitPrice,
            orderSize: adjustedOrderSize,
            slippageTolerance,
            liquidityThreshold,
        };
    }

    /**
     * Calculate comprehensive order book metrics
     * @param orderBook - Order book to analyze
     * @returns Order book metrics
     */
    calculateMetrics(orderBook: OrderBook): OrderBookMetrics | undefined {
        if (orderBook.bids.length === 0 || orderBook.asks.length === 0) {
            return undefined;
        }

        const bestBidPrice = parseFloat(orderBook.bids[0].px);
        const bestAskPrice = parseFloat(orderBook.asks[0].px);
        const midPrice = (bestBidPrice + bestAskPrice) / 2;

        const bidAskSpread = bestAskPrice - bestBidPrice;
        const bidAskSpreadPercentage = (bidAskSpread / midPrice) * 100;

        const totalBidVolume = orderBook.bids.reduce(
            (sum, level) => sum + parseFloat(level.sz),
            0
        );
        const totalAskVolume = orderBook.asks.reduce(
            (sum, level) => sum + parseFloat(level.sz),
            0
        );

        // Calculate liquidity depth at different price levels
        const liquidityDepth = new Map<number, number>();
        for (let levels = 1; levels <= 10; levels++) {
            const depth = this.calculateLiquidityDepth(orderBook, levels);
            liquidityDepth.set(levels, depth.bidVolume + depth.askVolume);
        }

        return {
            bidAskSpread,
            bidAskSpreadPercentage,
            bestBidPrice,
            bestAskPrice,
            totalBidVolume,
            totalAskVolume,
            midPrice,
            liquidityDepth,
        };
    }

    /**
     * Calculate total volume for a side
     * @param orderBook - Order book to analyze
     * @param side - 'buy' or 'sell'
     * @returns Total volume
     */
    private calculateTotalVolume(orderBook: OrderBook, side: 'buy' | 'sell'): number {
        const levels = side === 'buy' ? orderBook.asks : orderBook.bids;
        return levels.reduce((sum, level) => sum + parseFloat(level.sz), 0);
    }
}

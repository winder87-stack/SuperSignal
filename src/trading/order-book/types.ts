import { Level } from '../../types/hyperliquid.js';

/**
 * Order book level extending the base Level type
 */
export interface OrderBookLevel extends Level {
    /**
     * Cumulative volume up to this level
     */
    cumulativeVolume?: number;
}

/**
 * Complete order book structure
 */
export interface OrderBook {
    /**
     * Array of bid levels (sorted descending by price)
     */
    bids: OrderBookLevel[];
    /**
     * Array of ask levels (sorted ascending by price)
     */
    asks: OrderBookLevel[];
    /**
     * Timestamp of the order book snapshot
     */
    timestamp: number;
    /**
     * Coin symbol (e.g., "BTC", "ETH")
     */
    coin: string;
}

/**
 * Order book metrics
 */
export interface OrderBookMetrics {
    /**
     * Absolute bid-ask spread
     */
    bidAskSpread: number;
    /**
     * Bid-ask spread as percentage of mid price
     */
    bidAskSpreadPercentage: number;
    /**
     * Best bid price
     */
    bestBidPrice: number;
    /**
     * Best ask price
     */
    bestAskPrice: number;
    /**
     * Total bid volume across all levels
     */
    totalBidVolume: number;
    /**
     * Total ask volume across all levels
     */
    totalAskVolume: number;
    /**
     * Mid price (average of best bid and ask)
     */
    midPrice: number;
    /**
     * Cumulative volume at different price levels
     * Key is the number of levels, value is cumulative volume
     */
    liquidityDepth: Map<number, number>;
}

/**
 * Slippage estimation result
 */
export interface SlippageEstimate {
    /**
     * Estimated slippage as percentage
     */
    estimatedSlippage: number;
    /**
     * Total liquidity available at target price
     */
    liquidityAvailable: number;
    /**
     * Recommended order size based on liquidity
     */
    recommendedOrderSize: number;
    /**
     * Market impact score (0-1, higher = more impact)
     */
    marketImpactScore: number;
}

/**
 * Execution parameters for order placement
 */
export interface ExecutionParameters {
    /**
     * Limit price adjusted for slippage
     */
    limitPrice: number;
    /**
     * Order size adjusted for liquidity
     */
    orderSize: number;
    /**
     * Slippage tolerance as percentage
     */
    slippageTolerance: number;
    /**
     * Minimum volume threshold required
     */
    liquidityThreshold: number;
}

/**
 * High liquidity zone identified in order book
 */
export interface LiquidityZone {
    /**
     * Price level
     */
    price: number;
    /**
     * Volume at this level
     */
    volume: number;
    /**
     * Percentage of total volume
     */
    volumePercentage: number;
}

/**
 * Order book update event
 */
export interface OrderBookUpdateEvent {
    /**
     * Coin symbol
     */
    coin: string;
    /**
     * Updated order book
     */
    orderBook: OrderBook;
    /**
     * Timestamp of update
     */
    timestamp: number;
}

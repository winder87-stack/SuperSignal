import { EventEmitter } from 'events';
import { Level, L2Book } from '../../types/hyperliquid.js';
import {
    OrderBook,
    OrderBookLevel,
    OrderBookUpdateEvent,
} from './types.js';

/**
 * OrderBookManager - Manages order book data for multiple coins
 * Maintains a Map of order books by coin symbol and emits events on updates
 */
export class OrderBookManager extends EventEmitter {
    /**
     * Map of order books indexed by coin symbol
     */
    private orderBooks: Map<string, OrderBook>;

    constructor() {
        super();
        this.orderBooks = new Map();
    }

    /**
     * Update order book with new levels from L2Book event
     * @param coin - Coin symbol (e.g., "BTC", "ETH")
     * @param levels - Array of levels from L2Book event [Bids, Asks]
     */
    updateOrderBook(coin: string, levels: [Level[], Level[]]): void {
        const [bids, asks] = levels;
        const timestamp = Date.now();

        // Convert Level arrays to OrderBookLevel arrays
        const orderBookBids: OrderBookLevel[] = bids.map((level) => ({
            ...level,
            cumulativeVolume: undefined,
        }));

        const orderBookAsks: OrderBookLevel[] = asks.map((level) => ({
            ...level,
            cumulativeVolume: undefined,
        }));

        const orderBook: OrderBook = {
            bids: orderBookBids,
            asks: orderBookAsks,
            timestamp,
            coin,
        };

        this.orderBooks.set(coin, orderBook);

        // Emit update event
        const updateEvent: OrderBookUpdateEvent = {
            coin,
            orderBook,
            timestamp,
        };
        this.emit('orderBookUpdate', updateEvent);
    }

    /**
     * Update order book from L2Book event structure
     * @param l2Book - L2Book event from HyperLiquid WebSocket
     */
    updateFromL2Book(l2Book: L2Book): void {
        this.updateOrderBook(l2Book.coin, l2Book.levels);
    }

    /**
     * Get current order book for a coin
     * @param coin - Coin symbol
     * @returns OrderBook or undefined if not found
     */
    getOrderBook(coin: string): OrderBook | undefined {
        return this.orderBooks.get(coin);
    }

    /**
     * Get best bid price for a coin
     * @param coin - Coin symbol
     * @returns Best bid price or undefined if no order book
     */
    getBestBid(coin: string): number | undefined {
        const orderBook = this.orderBooks.get(coin);
        if (!orderBook || orderBook.bids.length === 0) {
            return undefined;
        }
        return parseFloat(orderBook.bids[0].px);
    }

    /**
     * Get best ask price for a coin
     * @param coin - Coin symbol
     * @returns Best ask price or undefined if no order book
     */
    getBestAsk(coin: string): number | undefined {
        const orderBook = this.orderBooks.get(coin);
        if (!orderBook || orderBook.asks.length === 0) {
            return undefined;
        }
        return parseFloat(orderBook.asks[0].px);
    }

    /**
     * Get mid price for a coin (average of best bid and ask)
     * @param coin - Coin symbol
     * @returns Mid price or undefined if no order book
     */
    getMidPrice(coin: string): number | undefined {
        const bestBid = this.getBestBid(coin);
        const bestAsk = this.getBestAsk(coin);

        if (bestBid === undefined || bestAsk === undefined) {
            return undefined;
        }

        return (bestBid + bestAsk) / 2;
    }

    /**
     * Get total volume at specified depth
     * @param coin - Coin symbol
     * @param depth - Number of levels to include
     * @param side - 'bid', 'ask', or 'both' (default: 'both')
     * @returns Total volume at specified depth
     */
    getTotalVolume(
        coin: string,
        depth: number,
        side: 'bid' | 'ask' | 'both' = 'both'
    ): number {
        const orderBook = this.orderBooks.get(coin);
        if (!orderBook) {
            return 0;
        }

        let totalVolume = 0;

        if (side === 'bid' || side === 'both') {
            const bidDepth = Math.min(depth, orderBook.bids.length);
            for (let i = 0; i < bidDepth; i++) {
                totalVolume += parseFloat(orderBook.bids[i].sz);
            }
        }

        if (side === 'ask' || side === 'both') {
            const askDepth = Math.min(depth, orderBook.asks.length);
            for (let i = 0; i < askDepth; i++) {
                totalVolume += parseFloat(orderBook.asks[i].sz);
            }
        }

        return totalVolume;
    }

    /**
     * Get cumulative volume at each price level
     * @param coin - Coin symbol
     * @param side - 'bid' or 'ask'
     * @returns Array of cumulative volumes at each level
     */
    getCumulativeVolume(
        coin: string,
        side: 'bid' | 'ask'
    ): number[] {
        const orderBook = this.orderBooks.get(coin);
        if (!orderBook) {
            return [];
        }

        const levels = side === 'bid' ? orderBook.bids : orderBook.asks;
        const cumulativeVolumes: number[] = [];
        let cumulative = 0;

        for (const level of levels) {
            cumulative += parseFloat(level.sz);
            cumulativeVolumes.push(cumulative);
        }

        return cumulativeVolumes;
    }

    /**
     * Check if order book exists for a coin
     * @param coin - Coin symbol
     * @returns True if order book exists
     */
    hasOrderBook(coin: string): boolean {
        return this.orderBooks.has(coin);
    }

    /**
     * Get all coin symbols with order books
     * @returns Array of coin symbols
     */
    getAvailableCoins(): string[] {
        return Array.from(this.orderBooks.keys());
    }

    /**
     * Clear order book for a specific coin
     * @param coin - Coin symbol
     */
    clearOrderBook(coin: string): void {
        this.orderBooks.delete(coin);
    }

    /**
     * Clear all order books
     */
    clearAllOrderBooks(): void {
        this.orderBooks.clear();
    }
}

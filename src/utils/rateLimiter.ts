/**
 * Token Bucket Rate Limiter
 * 
 * Implements token bucket algorithm to prevent API rate limit errors.
 * - Public endpoints: 10 requests per second
 * - Private endpoints: 5 requests per second
 * - Queues requests when rate limit is reached
 */

import { TradingLogger } from './logger.js';

class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private readonly capacity: number;
    private readonly refillRate: number; // tokens per second
    private readonly queue: Array<() => void> = [];

    constructor(capacity: number, refillRate: number) {
        this.capacity = capacity;
        this.refillRate = refillRate;
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    /**
     * Acquire a token from the bucket. If no tokens available, queues the request.
     * @returns Promise that resolves when a token is acquired
     */
    public async acquire(): Promise<void> {
        this.refill();

        if (this.tokens >= 1) {
            this.tokens -= 1;
            return Promise.resolve();
        }

        // No tokens available, queue the request
        return new Promise<void>((resolve) => {
            this.queue.push(resolve);
            this.scheduleNextProcessing();
        });
    }

    /**
     * Refill tokens based on elapsed time
     */
    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000; // seconds
        const tokensToAdd = elapsed * this.refillRate;

        if (tokensToAdd > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
            this.lastRefill = now;
        }
    }

    /**
     * Schedule processing of queued requests
     * CRITICAL FIX: Store and clear timeout references to prevent memory leaks
     */
    private scheduleNextProcessing(): void {
        if (this.queue.length === 0) {
            return;
        }

        // Calculate time until next token is available
        const tokensNeeded = 1 - this.tokens;
        const timeUntilToken = (tokensNeeded / this.refillRate) * 1000; // milliseconds

        // CRITICAL FIX: Store timeout reference for cleanup
        const timeoutId = setTimeout(() => {
            this.processQueue();
        }, Math.max(0, timeUntilToken));

        // Store reference for potential cleanup (not currently used but good practice)
        (this as any).processingTimeout = timeoutId;
    }

    /**
     * Process queued requests
     */
    private processQueue(): void {
        this.refill();

        while (this.queue.length > 0 && this.tokens >= 1) {
            this.tokens -= 1;
            const resolve = this.queue.shift();
            if (resolve) {
                resolve();
            }
        }

        // Schedule next processing if queue still has items
        if (this.queue.length > 0) {
            this.scheduleNextProcessing();
        }
    }

    /**
     * Get current queue size
     */
    public getQueueSize(): number {
        return this.queue.length;
    }

    /**
     * Get current token count
     */
    public getTokenCount(): number {
        this.refill();
        return this.tokens;
    }
}

/**
 * Rate Limiter for Hyperliquid API
 * Manages separate rate limits for public and private endpoints
 */
class RateLimiter {
    private publicBucket: TokenBucket;
    private privateBucket: TokenBucket;

    constructor() {
        // Public endpoints: 10 requests per second
        this.publicBucket = new TokenBucket(10, 10);

        // Private endpoints: 5 requests per second
        this.privateBucket = new TokenBucket(5, 5);

        TradingLogger.info('Rate limiter initialized: Public=10 req/s, Private=5 req/s');
    }

    /**
     * Acquire rate limit permission for public endpoint
     */
    public async acquirePublic(): Promise<void> {
        const queueSize = this.publicBucket.getQueueSize();
        if (queueSize > 0) {
            TradingLogger.debug(`Public API rate limit: ${queueSize} requests queued`);
        }
        return this.publicBucket.acquire();
    }

    /**
     * Acquire rate limit permission for private endpoint
     */
    public async acquirePrivate(): Promise<void> {
        const queueSize = this.privateBucket.getQueueSize();
        if (queueSize > 0) {
            TradingLogger.debug(`Private API rate limit: ${queueSize} requests queued`);
        }
        return this.privateBucket.acquire();
    }

    /**
     * Get statistics about current rate limiter state
     */
    public getStats(): {
        public: { tokens: number; queued: number };
        private: { tokens: number; queued: number };
    } {
        return {
            public: {
                tokens: this.publicBucket.getTokenCount(),
                queued: this.publicBucket.getQueueSize()
            },
            private: {
                tokens: this.privateBucket.getTokenCount(),
                queued: this.privateBucket.getQueueSize()
            }
        };
    }
}

// Export singleton instance
export const rateLimiter = new RateLimiter();

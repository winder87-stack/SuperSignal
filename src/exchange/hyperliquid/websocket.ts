import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import {
    HYPERLIQUID_WS_URL,
    HYPERLIQUID_TESTNET_WS_URL,
    WsRequest,
    L2Book,
    UserFill
} from '../../types/hyperliquid.js';
import { TradingLogger, generateRequestId } from '../../utils/logger.js';
import { intervalManager } from '../../utils/intervalManager.js';

// ============================================================================
// TYPE GUARDS FOR RUNTIME VALIDATION
// ============================================================================

/**
 * Validates that a value is a finite number (not NaN or Infinity)
 */
function isValidNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validates that a value is a non-empty string
 */
function isValidString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

/**
 * Validates a Level object (price level in order book)
 */
function isValidLevel(value: unknown): value is { px: string; sz: string; n: number } {
    if (!value || typeof value !== 'object') return false;
    const level = value as Record<string, unknown>;
    return isValidString(level.px) && isValidString(level.sz) && isValidNumber(level.n);
}

/**
 * Validates L2Book message structure
 */
function isValidL2Book(value: unknown): value is L2Book {
    if (!value || typeof value !== 'object') return false;
    const book = value as Record<string, unknown>;

    // Check required fields
    if (!isValidString(book.coin)) return false;
    if (!isValidNumber(book.time)) return false;
    if (!Array.isArray(book.levels) || book.levels.length !== 2) return false;

    // Validate bids and asks arrays
    const [bids, asks] = book.levels as unknown[][];
    if (!Array.isArray(bids) || !Array.isArray(asks)) return false;

    // Validate each level (optional - skip if empty arrays)
    for (const bid of bids) {
        if (!isValidLevel(bid)) return false;
    }
    for (const ask of asks) {
        if (!isValidLevel(ask)) return false;
    }

    return true;
}

/**
 * Validates UserFill message structure
 */
function isValidUserFill(value: unknown): value is UserFill {
    if (!value || typeof value !== 'object') return false;
    const fill = value as Record<string, unknown>;

    return (
        isValidString(fill.closedPnl) &&
        isValidString(fill.coin) &&
        typeof fill.crossMargin === 'boolean' &&
        isValidString(fill.dir) &&
        isValidString(fill.fee) &&
        isValidString(fill.feeToken) &&
        isValidString(fill.hash) &&
        isValidNumber(fill.oid) &&
        isValidString(fill.px) &&
        (fill.side === 'A' || fill.side === 'B') &&
        isValidString(fill.startPosition) &&
        isValidString(fill.sz) &&
        isValidNumber(fill.time)
    );
}

/**
 * Validates candle data structure
 */
function isValidCandle(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const candle = value as Record<string, unknown>;

    // Check required numeric fields
    const numericFields = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];
    for (const field of numericFields) {
        if (!isValidNumber(candle[field])) return false;
    }

    // Validate logical constraints
    const { open, high, low, close } = candle as { open: number; high: number; low: number; close: number };

    // High should be >= open, close, low
    if (high < open || high < close || high < low) return false;

    // Low should be <= open, close, high
    if (low > open || low > close || low > high) return false;

    return true;
}

/**
 * Validates the overall WebSocket message structure
 */
function isValidWsMessage(value: unknown): value is { channel: string; data: unknown } {
    if (!value || typeof value !== 'object') return false;
    const msg = value as Record<string, unknown>;

    // Must have a channel property
    if (!isValidString(msg.channel)) return false;

    // Must have a data property (can be any type)
    if (!('data' in msg)) return false;

    return true;
}

/**
 * Main validation function for WebSocket messages
 * Returns true if message is valid, false otherwise
 */
function validateMessage(msg: unknown): boolean {
    // First check if it's a valid message structure
    if (!isValidWsMessage(msg)) {
        TradingLogger.warn('Invalid WS message structure', { message: msg });
        return false;
    }

    // Validate based on channel type
    switch (msg.channel) {
        case 'l2Book':
            if (!isValidL2Book(msg.data)) {
                TradingLogger.warn('Invalid l2Book message data', { data: msg.data });
                return false;
            }
            break;

        case 'candle':
            if (!isValidCandle(msg.data)) {
                TradingLogger.warn('Invalid candle message data', { data: msg.data });
                return false;
            }
            break;

        case 'userFills':
            if (!isValidUserFill(msg.data)) {
                TradingLogger.warn('Invalid userFills message data', { data: msg.data });
                return false;
            }
            break;

        case 'pong':
            // Pong messages don't need validation
            break;

        default:
            // Unknown channel - log but don't crash
            TradingLogger.debug('Unknown WS message channel', { channel: msg.channel });
            break;
    }

    return true;
}

const PING_INTERVAL = 30000; // 30 seconds
const MAX_RECONNECT_ATTEMPTS = 10;
const SUBSCRIPTION_THROTTLE_MS = 200; // 5 subscriptions per second
const PONG_TIMEOUT = 10000; // 10 seconds - CRITICAL FIX: Add pong timeout detection

export class HyperLiquidWebSocket extends EventEmitter {
    private ws: WebSocket | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private isTestnet: boolean;
    private reconnectAttempts = 0;
    private shouldReconnect = true;
    private subscriptions: Set<string> = new Set();
    // CRITICAL FIX: Track pong responses for timeout detection
    private lastPongTime: number = Date.now();
    // CRITICAL FIX: Message buffering for reconnection
    private messageBuffer: Array<{ channel: string; data: unknown }> = [];
    private readonly MAX_BUFFER_SIZE = 100;

    constructor(isTestnet: boolean = false) {
        super();
        this.isTestnet = isTestnet;
    }

    public async connect(): Promise<void> {
        const url = this.isTestnet ? HYPERLIQUID_TESTNET_WS_URL : HYPERLIQUID_WS_URL;

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(url);

                this.ws.on('open', () => {
                    const requestId = generateRequestId();
                    TradingLogger.setRequestId(requestId);
                    TradingLogger.setComponent('HyperLiquidWebSocket');
                    TradingLogger.info("HyperLiquid WebSocket Connected", { requestId });
                    this.startPing();
                    this.reconnectAttempts = 0; // Reset counter on successful connection
                    this.resubscribe();
                    resolve();
                });

                this.ws.on('message', (data: Buffer) => {
                    this.handleMessage(data);
                });

                this.ws.on('close', () => {
                    TradingLogger.warn("HyperLiquid WebSocket Closed");
                    this.stopPing();
                    if (this.shouldReconnect) {
                        this.reconnect();
                    }
                });

                this.ws.on('error', (err: Error) => {
                    TradingLogger.logError(err, "HyperLiquid WebSocket Error");
                    // 'close' will trigger handling
                });

            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Disconnect WebSocket and clean up resources
     * CRITICAL FIX: Remove all event listeners to prevent memory leaks
     */
    public disconnect(): void {
        this.shouldReconnect = false;
        this.stopPing();
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
        // CRITICAL FIX: Remove all event listeners to prevent memory leaks
        this.removeAllListeners();
    }

    public subscribeToL2Book(coin: string): void {
        const subscription: WsRequest = {
            method: 'subscribe',
            subscription: {
                type: 'l2Book', // Confirm casing 'l2Book' works, some docs say 'l2Book'
                coin: coin
            }
        };
        this.send(subscription);
        this.subscriptions.add(JSON.stringify(subscription));
    }

    public subscribeToCandles(coin: string, interval: string): void {
        const subscription: WsRequest = {
            method: 'subscribe',
            subscription: {
                type: 'candle',
                coin: coin,
                interval: interval
            }
        };
        this.send(subscription);
        this.subscriptions.add(JSON.stringify(subscription));
    }

    public subscribeToUserFills(userAddress: string): void {
        const subscription: WsRequest = {
            method: 'subscribe',
            subscription: {
                type: 'userFills', // Verify exact type string
                user: userAddress
            }
        };
        this.send(subscription);
        this.subscriptions.add(JSON.stringify(subscription));
    }

    private send(data: WsRequest): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    /**
     * Start ping/pong heartbeat mechanism
     * CRITICAL FIX: Add pong timeout detection and message buffering
     */
    private startPing(): void {
        this.stopPing();
        this.lastPongTime = Date.now(); // Reset pong time on ping start
        this.pingInterval = intervalManager.setInterval(() => {
            // CRITICAL FIX: Check for pong timeout
            const timeSinceLastPong = Date.now() - this.lastPongTime;
            if (timeSinceLastPong > PONG_TIMEOUT) {
                TradingLogger.error('Pong timeout detected - closing connection');
                this.ws?.close();
                return;
            }
            this.send({ method: 'ping' });
        }, PING_INTERVAL, { name: 'websocket-ping' });
    }

    private stopPing(): void {
        if (this.pingInterval) {
            intervalManager.clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Reconnect WebSocket with exponential backoff
     * CRITICAL FIX: Add reconnection guard to prevent infinite loop
     */
    private reconnect(): void {
        // Check if max reconnect attempts reached
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            TradingLogger.error(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping reconnection.`);
            this.shouldReconnect = false;
            this.emit('fatal', new Error(`WebSocket reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`));
            return;
        }

        // Calculate exponential backoff delay: min(1000 * 2^attempts, 30000)
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        TradingLogger.info(`Reconnecting in ${delay}ms... (Attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

        // CRITICAL FIX: Use intervalManager instead of native setTimeout for better cleanup
        // Store the interval ID for cleanup
        const reconnectIntervalId = intervalManager.setInterval(() => {
            this.connect().catch((err) => {
                TradingLogger.error("Reconnection failed", err);
                // CRITICAL FIX: Only retry if still should reconnect (prevents infinite loop)
                if (this.shouldReconnect) {
                    this.reconnect(); // Retry again
                }
            });
        }, delay, { name: 'websocket-reconnect' });

        // Clear the interval after first execution (one-shot behavior)
        setTimeout(() => {
            intervalManager.clearInterval(reconnectIntervalId);
        }, delay + 100);
    }

    /**
     * Resubscribe to all channels after reconnection
     * CRITICAL FIX: Flush message buffer after reconnection
     */
    private async resubscribe(): Promise<void> {
        // CRITICAL FIX: Flush any buffered messages first
        if (this.messageBuffer.length > 0) {
            TradingLogger.info(`Flushing ${this.messageBuffer.length} buffered messages after reconnection`);
            const bufferedMessages = [...this.messageBuffer];
            this.messageBuffer = [];
            for (const bufferedMsg of bufferedMessages) {
                this.processBufferedMessage(bufferedMsg);
            }
        }

        // Throttle subscriptions to max 5 per second to prevent overwhelming server
        const subscriptionsArray = Array.from(this.subscriptions);

        for (let i = 0; i < subscriptionsArray.length; i++) {
            this.send(JSON.parse(subscriptionsArray[i]));

            // Wait between subscriptions if not the last one
            if (i < subscriptionsArray.length - 1) {
                await new Promise(resolve => setTimeout(resolve, SUBSCRIPTION_THROTTLE_MS));
            }
        }
    }

    /**
     * Handle incoming WebSocket messages
     * CRITICAL FIX: Add pong timeout detection and message buffering
     */
    private handleMessage(data: Buffer): void {
        try {
            const message = JSON.parse(data.toString());

            // Validate message structure and data before processing
            if (!validateMessage(message)) {
                // Validation already logged the reason
                return;
            }

            // CRITICAL FIX: Handle pong messages for timeout detection
            if (message.channel === 'pong') {
                this.lastPongTime = Date.now();
                return;
            }

            // CRITICAL FIX: Buffer messages during reconnection
            if (this.ws?.readyState !== WebSocket.OPEN) {
                this.messageBuffer.push({ channel: message.channel, data: message.data });
                if (this.messageBuffer.length > this.MAX_BUFFER_SIZE) {
                    this.messageBuffer.shift(); // Remove oldest message
                }
                return;
            }

            // CRITICAL FIX: Flush buffer when connected
            if (this.messageBuffer.length > 0) {
                const bufferedMessages = [...this.messageBuffer];
                this.messageBuffer = [];
                for (const bufferedMsg of bufferedMessages) {
                    this.processBufferedMessage(bufferedMsg);
                }
            }

            // Handle specific message types with individual try/catch for isolation
            if (message.channel === 'l2Book') {
                try {
                    const book: L2Book = message.data as L2Book;
                    this.emit('l2Book', book);
                } catch (err) {
                    TradingLogger.logError(err, 'Failed to process l2Book message');
                }
            } else if (message.channel === 'candle') {
                try {
                    this.emit('candle', message.data);
                } catch (err) {
                    TradingLogger.logError(err, 'Failed to process candle message');
                }
            } else if (message.channel === 'userFills') {
                try {
                    const fill: UserFill = message.data as UserFill;
                    this.emit('userFill', fill);
                } catch (err) {
                    TradingLogger.logError(err, 'Failed to process userFills message');
                }
            } else {
                // Initial subscription response or other info
                TradingLogger.debug('Unhandled WS message channel', { channel: message.channel });
            }
        } catch (err) {
            // JSON parse error or other unexpected error
            TradingLogger.logError(err, 'Failed to parse WS message');
        }
    }

    /**
     * Process a buffered message
     */
    private processBufferedMessage(message: { channel: string; data: unknown }): void {
        if (message.channel === 'l2Book') {
            try {
                const book: L2Book = message.data as L2Book;
                this.emit('l2Book', book);
            } catch (err) {
                TradingLogger.logError(err, 'Failed to process buffered l2Book message');
            }
        } else if (message.channel === 'candle') {
            try {
                this.emit('candle', message.data);
            } catch (err) {
                TradingLogger.logError(err, 'Failed to process buffered candle message');
            }
        } else if (message.channel === 'userFills') {
            try {
                const fill: UserFill = message.data as UserFill;
                this.emit('userFill', fill);
            } catch (err) {
                TradingLogger.logError(err, 'Failed to process buffered userFills message');
            }
        }
    }
}

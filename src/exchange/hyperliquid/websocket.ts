import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import {
    HYPERLIQUID_WS_URL,
    HYPERLIQUID_TESTNET_WS_URL,
    WsRequest,
    L2Book,
    UserFill
} from '../../types/hyperliquid.js';
import { TradingLogger } from '../../utils/logger.js';

const PING_INTERVAL = 30000; // 30 seconds

export class HyperLiquidWebSocket extends EventEmitter {
    private ws: WebSocket | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private isTestnet: boolean;
    private reconnectAttempts = 0;
    private shouldReconnect = true;
    private subscriptions: Set<string> = new Set();

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
                    TradingLogger.info("HyperLiquid WebSocket Connected");
                    this.startPing();
                    this.reconnectAttempts = 0;
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

    public disconnect(): void {
        this.shouldReconnect = false;
        this.stopPing();
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
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

    private send(data: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    private startPing(): void {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            this.send({ method: 'ping' });
        }, PING_INTERVAL);
    }

    private stopPing(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    private reconnect(): void {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        TradingLogger.info(`Reconnecting in ${delay}ms... (Attempt ${this.reconnectAttempts})`);

        setTimeout(() => {
            this.connect().catch((err) => {
                TradingLogger.logError(err, "Reconnection failed");
                this.reconnect(); // Retry again
            });
        }, delay);
    }

    private resubscribe(): void {
        for (const sub of this.subscriptions) {
            this.send(JSON.parse(sub));
        }
    }

    private handleMessage(data: Buffer): void {
        try {
            const message = JSON.parse(data.toString());

            // Handle specific message types
            if (message.channel === 'l2Book') {
                const book: L2Book = message.data;
                this.emit('l2Book', book);
            } else if (message.channel === 'candle') {
                this.emit('candle', message.data);
            } else if (message.channel === 'userFills') { // Check channel name
                const fill: UserFill = message.data;
                this.emit('userFill', fill);
            } else if (message.channel === 'pong') {
                // Pong received
            } else {
                // Initial subscription response or other info
                // console.log("WS Message:", message);
            }
        } catch (err) {
            console.error("Failed to parse WS message", err);
        }
    }
}

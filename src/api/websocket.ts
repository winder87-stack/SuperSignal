import { WebSocketServer, WebSocket } from 'ws';
import { TradingLogger } from '../utils/logger.js';

export class BotWebSocketServer {
    private wss: WebSocketServer;
    private clients: Set<WebSocket> = new Set();
    // CRITICAL FIX: Track client heartbeat state
    private clientHeartbeats: Map<WebSocket, number> = new Map();
    private heartbeatInterval: NodeJS.Timeout | null = null;

    /**
     * Constructor for BotWebSocketServer
     * CRITICAL FIX: Add try-catch around new WebSocketServer() to handle unhandled exceptions
     */
    constructor(port: number = 8080) {
        try {
            this.wss = new WebSocketServer({ port });

            this.wss.on('connection', (ws) => {
                this.clients.add(ws);
                // CRITICAL FIX: Initialize heartbeat tracking for new client
                this.clientHeartbeats.set(ws, Date.now());
                TradingLogger.info(`New internal WebSocket client connected. Total: ${this.clients.size}`);

                ws.send(JSON.stringify({ type: 'info', message: 'Connected to Hyperliquid Super Signal Bot' }));

                ws.on('message', (data: string) => {
                    try {
                        const message = JSON.parse(data);
                        // CRITICAL FIX: Handle ping/pong for heartbeat
                        if (message.type === 'ping') {
                            ws.send(JSON.stringify({ type: 'pong' }));
                            this.clientHeartbeats.set(ws, Date.now());
                        } else if (message.type === 'pong') {
                            this.clientHeartbeats.set(ws, Date.now());
                        }
                    } catch (error) {
                        TradingLogger.logError(error, 'Failed to parse WebSocket message');
                    }
                });

                ws.on('close', () => {
                    this.clients.delete(ws);
                    // CRITICAL FIX: Clean up heartbeat tracking
                    this.clientHeartbeats.delete(ws);
                    TradingLogger.info(`Internal WebSocket client disconnected. Total: ${this.clients.size}`);
                });

                ws.on('error', (err) => {
                    TradingLogger.error(`Internal WebSocket client error: ${err.message}`);
                    this.clients.delete(ws);
                    this.clientHeartbeats.delete(ws);
                });
            });

            this.wss.on('error', (err) => {
                TradingLogger.error(`Internal WebSocket Server Error: ${err.message}`);
            });

            // CRITICAL FIX: Start heartbeat mechanism to detect stale connections
            this.startHeartbeat();

            TradingLogger.info(`Internal WebSocket Server started on port ${port}`);
        } catch (error) {
            TradingLogger.logError(error, 'Failed to create WebSocket server');
            throw error; // Re-throw to fail fast if server can't be created
        }
    }

    /**
     * Start heartbeat mechanism to detect stale connections
     * CRITICAL FIX: Add heartbeat mechanism for connection health
     */
    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            const now = Date.now();
            const staleThreshold = 60000; // 60 seconds

            for (const [client, lastHeartbeat] of this.clientHeartbeats.entries()) {
                if (now - lastHeartbeat > staleThreshold) {
                    TradingLogger.warn('Closing stale WebSocket connection (no heartbeat in 60s)');
                    client.terminate();
                    this.clients.delete(client);
                    this.clientHeartbeats.delete(client);
                }
            }
        }, 30000); // Check every 30 seconds
    }

    public broadcast(type: string, data: unknown): void {
        const message = JSON.stringify({
            type,
            timestamp: Date.now(),
            data
        });

        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    }

    public close(): void {
        // CRITICAL FIX: Clear heartbeat interval
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        this.wss.close();
    }
}

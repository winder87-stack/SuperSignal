import { WebSocketServer, WebSocket } from 'ws';
import { TradingLogger } from '../utils/logger.js';

export class BotWebSocketServer {
    private wss: WebSocketServer;
    private clients: Set<WebSocket> = new Set();

    constructor(port: number = 8080) {
        this.wss = new WebSocketServer({ port });

        this.wss.on('connection', (ws) => {
            this.clients.add(ws);
            TradingLogger.info(`New internal WebSocket client connected. Total: ${this.clients.size}`);

            ws.send(JSON.stringify({ type: 'info', message: 'Connected to Hyperliquid Super Signal Bot' }));

            ws.on('close', () => {
                this.clients.delete(ws);
                TradingLogger.info(`Internal WebSocket client disconnected. Total: ${this.clients.size}`);
            });

            ws.on('error', (err) => {
                TradingLogger.error(`Internal WebSocket client error: ${err.message}`);
                this.clients.delete(ws);
            });
        });

        this.wss.on('error', (err) => {
            TradingLogger.error(`Internal WebSocket Server Error: ${err.message}`);
        });

        TradingLogger.info(`Internal WebSocket Server started on port ${port}`);
    }

    public broadcast(type: string, data: any) {
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

    public close() {
        this.wss.close();
    }
}

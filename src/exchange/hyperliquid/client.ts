import { HyperLiquidAPI } from './api.js';
import { HyperLiquidWebSocket } from './websocket.js';
import { AssetIndexManager } from './asset-index.js';
import { TradingLogger } from '../../utils/logger.js';
import { EventEmitter } from 'events';

export class HyperLiquidClient extends EventEmitter {
    public api: HyperLiquidAPI;
    public ws: HyperLiquidWebSocket;
    public assetIndex: AssetIndexManager;

    constructor(privateKey: string, isTestnet: boolean = false) {
        super();
        this.api = new HyperLiquidAPI(privateKey, isTestnet);
        this.ws = new HyperLiquidWebSocket(isTestnet);
        this.assetIndex = new AssetIndexManager(this.api);

        // Forward WS events
        this.ws.on('l2Book', (data) => this.emit('l2Book', data));
        this.ws.on('userFill', (data) => this.emit('userFill', data));
    }

    public async connect(): Promise<void> {
        try {
            // Initialize asset index mappings before connecting
            await this.assetIndex.initialize();
            await this.ws.connect();
            TradingLogger.info("HyperLiquid Client Connected");
        } catch (error) {
            TradingLogger.error("Failed to connect HyperLiquid Client");
            throw error;
        }
    }

    public disconnect(): void {
        this.ws.disconnect();
    }
}

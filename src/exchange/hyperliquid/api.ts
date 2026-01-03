import axios, { AxiosInstance } from 'axios';
import { Wallet } from 'ethers';
import {
    HYPERLIQUID_API_URL,
    HYPERLIQUID_TESTNET_API_URL,
    MetaAndAssetCtxsResponse,
} from '../../types/hyperliquid.js';
import { signL1Action } from './signing.js';
import { TradingLogger } from '../../utils/logger.js';

export class HyperLiquidAPI {
    private client: AxiosInstance;
    private wallet: Wallet;
    private isTestnet: boolean;

    constructor(privateKey: string, isTestnet: boolean = false) {
        this.isTestnet = isTestnet;
        this.wallet = new Wallet(privateKey);
        this.client = axios.create({
            baseURL: isTestnet ? HYPERLIQUID_TESTNET_API_URL : HYPERLIQUID_API_URL,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }

    public getAddress(): string {
        return this.wallet.address;
    }

    /**
     * Get meta information and asset contexts
     * @returns Promise resolving to meta and asset context data
     */
    public async getMetaAndAssetCtxs(): Promise<MetaAndAssetCtxsResponse> {
        return this.postInfo({ type: 'metaAndAssetCtxs' });
    }

    public async getUserState(user: string): Promise<any> {
        return this.postInfo({ type: 'clearinghouseState', user });
    }

    public async getOpenOrders(user: string): Promise<any> {
        return this.postInfo({ type: 'openOrders', user });
    }

    /**
     * Get historical candle data
     * @param coin Asset symbol (e.g., 'SOL', 'BTC')
     * @param interval Candle interval (e.g., '3m', '1h')
     * @param startTime Start time in milliseconds
     * @param endTime End time in milliseconds
     */
    public async getCandleSnapshot(
        coin: string,
        interval: string,
        startTime: number,
        endTime: number
    ): Promise<any[]> {
        return this.postInfo({
            type: 'candleSnapshot',
            req: {
                coin,
                interval,
                startTime,
                endTime
            }
        });
    }

    /**
     * Place an order
     * @param orders List of orders to place
     * @param grouping "na" for normal orders
     */
    public async placeOrder(orders: any[], grouping: 'na' | 'normalTpsl' = 'na'): Promise<any> {
        // Ensure precision for each order
        const formattedOrders = orders.map(o => ({
            ...o,
            px: typeof o.px === 'string' ? o.px : Number(o.px).toFixed(6).replace(/\.?0+$/, ''),
            sz: typeof o.sz === 'string' ? o.sz : Number(o.sz).toFixed(8).replace(/\.?0+$/, '')
        }));

        const action = {
            type: 'order',
            orders: formattedOrders,
            grouping: grouping
        };
        return this.executeAction(action);
    }

    /**
     * Cancel orders
     * @param cancels List of { a: assetId, o: orderId }
     */
    public async cancelOrders(cancels: any[]): Promise<any> {
        const action = {
            type: 'cancel',
            cancels: cancels
        };
        return this.executeAction(action);
    }

    public async updateLeverage(assetId: number, isCross: boolean, leverage: number): Promise<any> {
        const action = {
            type: 'updateLeverage',
            asset: assetId,
            isCross: isCross,
            leverage: leverage
        };
        return this.executeAction(action);
    }

    private async executeAction(action: any): Promise<any> {
        try {
            const nonce = Date.now();
            const signature = await signL1Action(this.wallet, action, this.isTestnet, nonce);

            const payload = {
                action: action,
                nonce: nonce,
                signature: signature,
                vaultAddress: null // Use null for main wallet
            };

            const response = await this.client.post('/exchange', payload);

            if (response.data.status === 'err') {
                throw new Error(`HyperLiquid API Error: ${response.data.response}`);
            }

            return response.data;
        } catch (error: any) {
            TradingLogger.error(`API Action Failed: ${error.message}`);
            if (error.response) {
                TradingLogger.error(`Response: ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    }

    private async postInfo(body: any): Promise<any> {
        try {
            const response = await this.client.post('/info', body);
            return response.data;
        } catch (error: any) {
            TradingLogger.error(`API Info Failed: ${error.message}`);
            throw error;
        }
    }
}

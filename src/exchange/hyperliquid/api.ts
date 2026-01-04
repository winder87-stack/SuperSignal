import axios, { AxiosInstance, AxiosError } from 'axios';
import { Wallet } from 'ethers';
import {
    HYPERLIQUID_API_URL,
    HYPERLIQUID_TESTNET_API_URL,
    MetaAndAssetCtxsResponse,
    OrderWire,
    OpenOrder,
    UserState,
    OrderResponse,
    CancelOrderRequest,
} from '../../types/hyperliquid.js';
import { signL1Action } from './signing.js';
import { TradingLogger, generateRequestId, startPerformanceTimer } from '../../utils/logger.js';
import { rateLimiter } from '../../utils/rateLimiter.js';
import { TimeoutError } from '../../utils/errors.js';

/**
 * Candle data from the API
 */
export interface CandleData {
    t: number; // Open time
    T: number; // Close time
    s: string; // Symbol
    i: string; // Interval
    o: string; // Open
    h: string; // High
    l: string; // Low
    c: string; // Close
    v: string; // Volume
    n: number; // Number of trades
}

/**
 * Info request body types
 */
interface InfoRequest {
    type: string;
    user?: string;
    req?: {
        coin: string;
        interval: string;
        startTime: number;
        endTime: number;
    };
}

/**
 * Order action structure
 */
interface OrderAction {
    type: 'order';
    orders: OrderWire[];
    grouping: 'na' | 'normalTpsl';
}

/**
 * Cancel action structure
 */
interface CancelAction {
    type: 'cancel';
    cancels: CancelOrderRequest[];
}

/**
 * Update leverage action structure
 */
interface UpdateLeverageAction {
    type: 'updateLeverage';
    asset: number;
    isCross: boolean;
    leverage: number;
}

type ExchangeAction = OrderAction | CancelAction | UpdateLeverageAction;

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

    public async getUserState(user: string): Promise<UserState> {
        return this.postInfo({ type: 'clearinghouseState', user });
    }

    public async getOpenOrders(user: string): Promise<OpenOrder[]> {
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
    ): Promise<CandleData[]> {
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
    public async placeOrder(orders: OrderWire[], grouping: 'na' | 'normalTpsl' = 'na'): Promise<OrderResponse> {
        // Ensure precision for each order
        const formattedOrders = orders.map(o => ({
            ...o,
            p: typeof o.p === 'string' ? o.p : Number(o.p).toFixed(6).replace(/\.?0+$/, ''),
            s: typeof o.s === 'string' ? o.s : Number(o.s).toFixed(8).replace(/\.?0+$/, '')
        }));

        const action: OrderAction = {
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
    public async cancelOrders(cancels: CancelOrderRequest[]): Promise<OrderResponse> {
        const action: CancelAction = {
            type: 'cancel',
            cancels: cancels
        };
        return this.executeAction(action);
    }

    public async updateLeverage(assetId: number, isCross: boolean, leverage: number): Promise<OrderResponse> {
        const action: UpdateLeverageAction = {
            type: 'updateLeverage',
            asset: assetId,
            isCross: isCross,
            leverage: leverage
        };
        return this.executeAction(action);
    }

    private async executeAction(action: ExchangeAction): Promise<OrderResponse> {
        const requestId = generateRequestId();
        TradingLogger.setRequestId(requestId);
        TradingLogger.setComponent('HyperLiquidAPI');

        const endTimer = startPerformanceTimer('executeAction');
        // CRITICAL FIX: Increase maxRetries from 1 to 5 for better resilience
        const maxRetries = 5; // Retry up to 5 times on timeout
        let attempts = 0;

        while (attempts <= maxRetries) {
            try {
                // Rate limit private API calls (5 req/s)
                await rateLimiter.acquirePrivate();

                const nonce = Date.now();
                const signature = await signL1Action(this.wallet, action, this.isTestnet, nonce);

                const payload = {
                    action: action,
                    nonce: nonce,
                    signature: signature,
                    vaultAddress: null // Use null for main wallet
                };

                // Add 10-second timeout to prevent hanging
                const response = await this.client.post('/exchange', payload, {
                    timeout: 10000 // 10 seconds
                });

                if (response.data.status === 'err') {
                    throw new Error(`HyperLiquid API Error: ${response.data.response}`);
                }

                const metrics = endTimer();
                TradingLogger.logPerformance('executeAction', metrics.duration, { requestId });

                return response.data;

            } catch (error: unknown) {
                // Check if it's a timeout error
                const axiosError = error as AxiosError;
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isTimeout = axiosError.code === 'ECONNABORTED' ||
                    errorMessage?.includes('timeout') ||
                    axiosError.code === 'ETIMEDOUT';

                if (isTimeout && attempts < maxRetries) {
                    attempts++;
                    TradingLogger.warn(
                        `API executeAction timeout (attempt ${attempts}/${maxRetries + 1}), retrying...`,
                        { requestId }
                    );
                    // Brief delay before retry
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                // Either not a timeout, or max retries exceeded
                if (isTimeout) {
                    const timeoutError = new TimeoutError(
                        `API request timed out after ${maxRetries + 1} attempts`
                    );
                    TradingLogger.logError(timeoutError, 'executeAction');
                    throw timeoutError;
                }

                // Other errors - log sanitized response data
                TradingLogger.error(`API Action Failed: ${errorMessage}`, {
                    requestId,
                    status: axiosError.response?.status,
                    statusText: axiosError.response?.statusText
                });
                throw error;
            }
        }

        // Should never reach here, but TypeScript needs it
        throw new Error('Unexpected error in executeAction');
    }

    private async postInfo<T>(body: InfoRequest): Promise<T> {
        const requestId = generateRequestId();
        TradingLogger.setRequestId(requestId);
        TradingLogger.setComponent('HyperLiquidAPI');

        const endTimer = startPerformanceTimer('postInfo');
        // CRITICAL FIX: Increase maxRetries from 1 to 5 for better resilience
        const maxRetries = 5; // Retry up to 5 times on timeout
        let attempts = 0;

        while (attempts <= maxRetries) {
            try {
                // Rate limit public API calls (10 req/s)
                await rateLimiter.acquirePublic();

                // Add 10-second timeout to prevent hanging
                const response = await this.client.post('/info', body, {
                    timeout: 10000 // 10 seconds
                });

                const metrics = endTimer();
                TradingLogger.logPerformance('postInfo', metrics.duration, { requestId, type: body.type });

                return response.data;

            } catch (error: unknown) {
                // Check if it's a timeout error
                const axiosError = error as AxiosError;
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isTimeout = axiosError.code === 'ECONNABORTED' ||
                    errorMessage?.includes('timeout') ||
                    axiosError.code === 'ETIMEDOUT';

                if (isTimeout && attempts < maxRetries) {
                    attempts++;
                    TradingLogger.warn(
                        `API postInfo timeout (attempt ${attempts}/${maxRetries + 1}), retrying...`,
                        { requestId, type: body.type }
                    );
                    // Brief delay before retry
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                // Either not a timeout, or max retries exceeded
                if (isTimeout) {
                    const timeoutError = new TimeoutError(
                        `API request timed out after ${maxRetries + 1} attempts`
                    );
                    TradingLogger.logError(timeoutError, 'postInfo');
                    throw timeoutError;
                }

                // Other errors
                TradingLogger.error(`API Info Failed: ${errorMessage}`, {
                    requestId,
                    type: body.type,
                    status: axiosError.response?.status
                });
                throw error;
            }
        }

        // Should never reach here, but TypeScript needs it
        throw new Error('Unexpected error in postInfo');
    }
}

/**
 * Asset context information from HyperLiquid API
 */
export interface AssetContext {
    /**
     * Asset symbol (e.g., "BTC", "ETH", "SOL")
     */
    name: string;
    /**
     * Asset index (integer)
     */
    idx: number;
    /**
     * Maximum leverage for this asset
     */
    maxLeverage: number;
    /**
     * Whether the asset is only for trading (not funding)
     */
    onlyIsolated: boolean;
}

/**
 * Universe entry - can be a string (legacy) or object with name property
 */
export interface UniverseEntry {
    name: string;
    szDecimals?: number;
    maxLeverage?: number;
    marginTableId?: number;
    onlyIsolated?: boolean;
    isDelisted?: boolean;
    marginMode?: string;
}

/**
 * Meta information from HyperLiquid API
 */
export interface MetaInfo {
    /**
     * Array of all available assets (can be strings or objects)
     */
    universe: (UniverseEntry | string)[];
}

/**
 * Complete response from metaAndAssetCtxs endpoint
 */
export interface MetaAndAssetCtxsResponse {
    /**
     * Meta information containing universe array
     */
    [0]: MetaInfo;
    /**
     * Array of asset contexts indexed by asset index
     */
    [1]: AssetContext[];
}

export interface Subscription {
    type: string;
    coin?: string;
    interval?: string;
    user?: string;
}

export interface WsRequest {
    method: 'subscribe' | 'unsubscribe' | 'ping';
    subscription?: Subscription;
}

export type Side = 'A' | 'B'; // Ask, Bid

export interface Level {
    px: string; // Price
    sz: string; // Size
    n: number;  // Number of orders
}

export interface L2Book {
    coin: string;
    time: number;
    levels: [Level[], Level[]]; // [Bids, Asks]
}

export interface FillRequestBody {
    coin: string;
    px: string;
    sz: string;
    side: string;
    time: number;
    startPosition: string;
    dir: string;
    closedPnl: string;
    hash: string;
    oid: number;
    tid: number;
    fee: string;
}

export interface UserFill {
    closedPnl: string;
    coin: string;
    crossMargin: boolean;
    dir: string; // "Open Long", "Close Short", etc
    fee: string;
    feeToken: string;
    hash: string;
    oid: number; // Order ID
    px: string;  // Price
    side: Side;
    startPosition: string;
    sz: string;  // Size
    time: number;
}

export interface OrderWire {
    a: number; // Asset index
    b: boolean; // Is buy?
    p: string; // Price
    s: string; // Size
    r: boolean; // Reduce only
    t: {
        limit?: {
            tif: 'Gtc' | 'Ioc' | 'Alo';
        };
        trigger?: {
            isMarket: boolean;
            triggerPx: string;
            tpsl: 'tp' | 'sl';
        }
    };
    c?: string; // Client Order ID (cloid)
}

export interface OrderAction {
    type: 'order';
    orders: OrderWire[];
    grouping: 'na';
}

export interface CancelOrderRequest {
    a: number; // Asset index
    o: number; // Order ID
}

export interface CancelAction {
    type: 'cancel';
    cancels: CancelOrderRequest[];
}

/**
 * Open order from getOpenOrders endpoint
 */
export interface OpenOrder {
    coin: string;
    oid: number;
    side: Side;
    sz: string;
    px: string;
    reduceOnly: boolean;
    orderType?: string;
    isTrigger?: boolean;
    triggerPx?: string;
    triggerCondition?: string;
    cloid?: string;
}

/**
 * Order placement response status
 */
export interface OrderStatus {
    filled?: {
        oid: number;
        totalSz: string;
        avgPx: string;
    };
    resting?: {
        oid: number;
    };
    error?: string;
}

/**
 * Response data from placeOrder API
 */
export interface OrderResponseData {
    type?: string;
    data?: {
        statuses: OrderStatus[];
    };
}

/**
 * Response from placeOrder API
 */
export interface OrderResponse {
    status: 'ok' | 'err';
    response?: OrderResponseData | string;
}

/**
 * Helper to get order response data safely
 * Returns the inner data object that contains statuses
 */
export function getOrderResponseData(response: OrderResponse): { statuses: OrderStatus[] } | undefined {
    if (response.response && typeof response.response === 'object') {
        const responseData = response.response as OrderResponseData;
        return responseData.data;
    }
    return undefined;
}

/**
 * Asset position from user state
 */
export interface AssetPosition {
    position: {
        coin: string;
        szi: string;
        entryPx: string;
        positionValue: string;
        unrealizedPnl: string;
        returnOnEquity: string;
        liquidationPx: string | null;
        marginUsed: string;
        maxTradeSzs: [string, string];
    };
    type: 'oneWay';
}

/**
 * Margin summary from user state
 */
export interface MarginSummary {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
}

/**
 * User state from getUserState endpoint
 */
export interface UserState {
    assetPositions: AssetPosition[];
    marginSummary?: MarginSummary;
    crossMarginSummary?: MarginSummary;
    withdrawable?: string;
}

/**
 * Metadata for log entries - allows any JSON-serializable values
 * Winston can handle complex nested objects
 */
export interface LogMetadata {
    [key: string]: unknown;
}

export const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz';
export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';
export const HYPERLIQUID_TESTNET_API_URL = 'https://api.hyperliquid-testnet.xyz';
export const HYPERLIQUID_TESTNET_WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';

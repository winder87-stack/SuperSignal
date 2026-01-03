import { Decimal } from 'decimal.js';

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

export const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz';
export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';
export const HYPERLIQUID_TESTNET_API_URL = 'https://api.hyperliquid-testnet.xyz';
export const HYPERLIQUID_TESTNET_WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';

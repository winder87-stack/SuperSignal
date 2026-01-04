/**
 * Type definitions for the Asset Index Mapping Module
 */

/**
 * Mapping of coin symbol to asset index
 */
export type AssetIndexMap = Map<string, number>;

/**
 * Reverse mapping of asset index to coin symbol
 */
export type ReverseAssetIndexMap = Map<number, string>;

/**
 * Complete asset mapping state
 */
export interface AssetMappingState {
    /**
     * Symbol to index mapping
     */
    symbolToIndex: AssetIndexMap;
    /**
     * Index to symbol mapping
     */
    indexToSymbol: ReverseAssetIndexMap;
    /**
     * Timestamp of last refresh
     */
    lastRefreshTime: number;
    /**
     * Whether the mapping is initialized
     */
    initialized: boolean;
}

/**
 * Configuration for AssetIndexManager
 */
export interface AssetIndexConfig {
    /**
     * Time-to-live for cached mappings in milliseconds
     * Default: 1 hour (3600000ms)
     */
    ttl?: number;
    /**
     * Whether to automatically refresh on TTL expiration
     * Default: false
     */
    autoRefresh?: boolean;
    /**
     * Maximum number of retry attempts on initialization failure
     * Default: 3
     */
    maxRetries?: number;
    /**
     * Delay between retry attempts in milliseconds
     * Default: 1000ms
     */
    retryDelay?: number;
}

/**
 * Error types for asset index operations
 */
export class AssetIndexError extends Error {
    constructor(
        message: string,
        public code: AssetIndexErrorCode,
        public details?: unknown
    ) {
        super(message);
        this.name = 'AssetIndexError';
        Error.captureStackTrace(this, this.constructor);
    }
}

export enum AssetIndexErrorCode {
    /**
     * Failed to initialize asset mappings
     */
    INITIALIZATION_FAILED = 'INITIALIZATION_FAILED',
    /**
     * Asset index not found for given symbol
     */
    ASSET_NOT_FOUND = 'ASSET_NOT_FOUND',
    /**
     * Mapping validation failed
     */
    VALIDATION_FAILED = 'VALIDATION_FAILED',
    /**
     * Manager not initialized
     */
    NOT_INITIALIZED = 'NOT_INITIALIZED',
    /**
     * API call failed
     */
    API_ERROR = 'API_ERROR',
    /**
     * Invalid configuration provided
     */
    INVALID_CONFIG = 'INVALID_CONFIG',
}

/**
 * Interface for AssetIndexManager
 */
export interface IAssetIndexManager {
    /**
     * Initialize manager by fetching asset mappings from API
     * @throws AssetIndexError if initialization fails
     */
    initialize(): Promise<void>;

    /**
     * Get asset index for a given coin symbol
     * @param coin - Coin symbol (e.g., "BTC", "ETH")
     * @returns Asset index (integer)
     * @throws AssetIndexError if symbol not found or not initialized
     */
    getAssetIndex(coin: string): number;

    /**
     * Get coin symbol for a given asset index
     * @param index - Asset index (integer)
     * @returns Coin symbol
     * @throws AssetIndexError if index not found or not initialized
     */
    getCoinSymbol(index: number): string;

    /**
     * Refresh asset mappings from API
     * @throws AssetIndexError if refresh fails
     */
    refresh(): Promise<void>;

    /**
     * Check if manager is initialized
     * @returns true if initialized, false otherwise
     */
    isInitialized(): boolean;

    /**
     * Get all current asset mappings
     * @returns Current mapping state
     */
    getAllMappings(): AssetMappingState;

    /**
     * Check if a coin symbol is valid
     * @param coin - Coin symbol to check
     * @returns true if valid, false otherwise
     */
    isValidCoin(coin: string): boolean;

    /**
     * Check if an asset index is valid
     * @param index - Asset index to check
     * @returns true if valid, false otherwise
     */
    isValidIndex(index: number): boolean;
}

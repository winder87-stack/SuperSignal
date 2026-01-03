/**
 * Asset Index Manager - Manages asset index mappings for HyperLiquid
 *
 * This module provides a high-performance, cached mapping between coin symbols
 * and their corresponding integer indices, eliminating redundant API calls.
 */

import { HyperLiquidAPI } from './api.js';
import { TradingLogger } from '../../utils/logger.js';
import {
    IAssetIndexManager,
    AssetIndexMap,
    ReverseAssetIndexMap,
    AssetMappingState,
    AssetIndexConfig,
    AssetIndexError,
    AssetIndexErrorCode,
} from '../../types/asset-index.js';
import { MetaAndAssetCtxsResponse } from '../../types/hyperliquid.js';

export class AssetIndexManager implements IAssetIndexManager {
    private assetIndexMap: AssetIndexMap = new Map();
    private reverseIndexMap: ReverseAssetIndexMap = new Map();
    private initialized: boolean = false;
    private lastRefreshTime: number = 0;
    private ttl: number;
    private autoRefresh: boolean;
    private maxRetries: number;
    private retryDelay: number;

    constructor(
        private api: HyperLiquidAPI,
        config?: AssetIndexConfig
    ) {
        this.ttl = config?.ttl ?? 3600000; // Default: 1 hour
        this.autoRefresh = config?.autoRefresh ?? false;
        this.maxRetries = config?.maxRetries ?? 3;
        this.retryDelay = config?.retryDelay ?? 1000;
    }

    /**
     * Initialize the manager by fetching asset mappings from API
     * @throws AssetIndexError if initialization fails
     */
    public async initialize(): Promise<void> {
        TradingLogger.info('Initializing AssetIndexManager...');

        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                await this.fetchAndCacheMappings();
                TradingLogger.info(
                    `AssetIndexManager initialized successfully with ${this.assetIndexMap.size} assets`
                );
                return;
            } catch (error) {
                lastError = error as Error;
                TradingLogger.warn(
                    `Initialization attempt ${attempt}/${this.maxRetries} failed: ${(error as Error).message}`
                );

                if (attempt < this.maxRetries) {
                    await this.sleep(this.retryDelay * attempt); // Exponential backoff
                }
            }
        }

        throw new AssetIndexError(
            `Failed to initialize AssetIndexManager after ${this.maxRetries} attempts`,
            AssetIndexErrorCode.INITIALIZATION_FAILED,
            lastError
        );
    }

    /**
     * Get the asset index for a given coin symbol
     * @param coin - Coin symbol (e.g., "BTC", "ETH")
     * @returns Asset index (integer)
     * @throws AssetIndexError if symbol not found or not initialized
     */
    public getAssetIndex(coin: string): number {
        if (!this.initialized) {
            throw new AssetIndexError(
                'AssetIndexManager is not initialized. Call initialize() first.',
                AssetIndexErrorCode.NOT_INITIALIZED
            );
        }

        // Check if auto-refresh is enabled and cache is expired
        if (this.autoRefresh && this.isCacheExpired()) {
            this.refresh().catch((error) => {
                TradingLogger.warn(`Failed to auto-refresh asset mappings: ${error.message}`);
            });
        }

        const index = this.assetIndexMap.get(coin);
        if (index === undefined) {
            throw new AssetIndexError(
                `Asset index not found for coin: ${coin}`,
                AssetIndexErrorCode.ASSET_NOT_FOUND,
                { coin }
            );
        }

        return index;
    }

    /**
     * Get the coin symbol for a given asset index
     * @param index - Asset index (integer)
     * @returns Coin symbol
     * @throws AssetIndexError if index not found or not initialized
     */
    public getCoinSymbol(index: number): string {
        if (!this.initialized) {
            throw new AssetIndexError(
                'AssetIndexManager is not initialized. Call initialize() first.',
                AssetIndexErrorCode.NOT_INITIALIZED
            );
        }

        const symbol = this.reverseIndexMap.get(index);
        if (symbol === undefined) {
            throw new AssetIndexError(
                `Coin symbol not found for asset index: ${index}`,
                AssetIndexErrorCode.ASSET_NOT_FOUND,
                { index }
            );
        }

        return symbol;
    }

    /**
     * Refresh the asset mappings from API
     * @throws AssetIndexError if refresh fails
     */
    public async refresh(): Promise<void> {
        TradingLogger.info('Refreshing asset mappings...');
        await this.fetchAndCacheMappings();
        TradingLogger.info('Asset mappings refreshed successfully');
    }

    /**
     * Check if the manager is initialized
     * @returns true if initialized, false otherwise
     */
    public isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get all current asset mappings
     * @returns Current mapping state
     */
    public getAllMappings(): AssetMappingState {
        return {
            symbolToIndex: new Map(this.assetIndexMap),
            indexToSymbol: new Map(this.reverseIndexMap),
            lastRefreshTime: this.lastRefreshTime,
            initialized: this.initialized,
        };
    }

    /**
     * Check if a coin symbol is valid
     * @param coin - Coin symbol to check
     * @returns true if valid, false otherwise
     */
    public isValidCoin(coin: string): boolean {
        return this.assetIndexMap.has(coin);
    }

    /**
     * Check if an asset index is valid
     * @param index - Asset index to check
     * @returns true if valid, false otherwise
     */
    public isValidIndex(index: number): boolean {
        return this.reverseIndexMap.has(index);
    }

    /**
     * Fetch asset mappings from API and cache them
     * @throws AssetIndexError if fetch or validation fails
     */
    private async fetchAndCacheMappings(): Promise<void> {
        try {
            const response: MetaAndAssetCtxsResponse = await this.api.getMetaAndAssetCtxs();

            // Validate response structure
            if (!response || !response[0] || !Array.isArray(response[0].universe)) {
                throw new AssetIndexError(
                    'Invalid API response structure',
                    AssetIndexErrorCode.API_ERROR,
                    { response }
                );
            }

            const universe = response[0].universe;

            // Clear existing mappings
            this.assetIndexMap.clear();
            this.reverseIndexMap.clear();

            // Build mappings from universe array
            // The universe array contains objects with a 'name' property (coin symbol)
            for (let index = 0; index < universe.length; index++) {
                const asset = universe[index];
                // Handle both object format { name: 'BTC', ... } and string format 'BTC'
                const symbol = typeof asset === 'string' ? asset : asset.name;
                if (!symbol) {
                    TradingLogger.warn(`Skipping universe entry at index ${index}: no name found`);
                    continue;
                }
                this.assetIndexMap.set(symbol, index);
                this.reverseIndexMap.set(index, symbol);
            }

            // Validate mappings
            if (!this.validateMappings()) {
                throw new AssetIndexError(
                    'Asset mapping validation failed',
                    AssetIndexErrorCode.VALIDATION_FAILED
                );
            }

            // Update state
            this.lastRefreshTime = Date.now();
            this.initialized = true;

        } catch (error) {
            if (error instanceof AssetIndexError) {
                throw error;
            }

            throw new AssetIndexError(
                `Failed to fetch asset mappings: ${(error as Error).message}`,
                AssetIndexErrorCode.API_ERROR,
                error
            );
        }
    }

    /**
     * Validate the integrity of asset mappings
     * @returns true if valid, false otherwise
     */
    private validateMappings(): boolean {
        // Check that both maps have the same size
        if (this.assetIndexMap.size !== this.reverseIndexMap.size) {
            TradingLogger.error('Validation failed: Map sizes do not match');
            return false;
        }

        // Check that all indices are non-negative integers
        for (const index of this.reverseIndexMap.keys()) {
            if (!Number.isInteger(index) || index < 0) {
                TradingLogger.error(`Validation failed: Invalid index ${index}`);
                return false;
            }
        }

        // Check that all symbols are non-empty strings
        for (const symbol of this.assetIndexMap.keys()) {
            if (typeof symbol !== 'string' || symbol.length === 0) {
                TradingLogger.error(`Validation failed: Invalid symbol ${symbol}`);
                return false;
            }
        }

        // Verify bidirectional consistency
        for (const [symbol, index] of this.assetIndexMap.entries()) {
            const reverseSymbol = this.reverseIndexMap.get(index);
            if (reverseSymbol !== symbol) {
                TradingLogger.error(
                    `Validation failed: Bidirectional mismatch for ${symbol} <-> ${index}`
                );
                return false;
            }
        }

        return true;
    }

    /**
     * Check if the cache has expired
     * @returns true if expired, false otherwise
     */
    private isCacheExpired(): boolean {
        if (this.lastRefreshTime === 0) {
            return true;
        }
        return Date.now() - this.lastRefreshTime > this.ttl;
    }

    /**
     * Sleep for a specified duration
     * @param ms - Milliseconds to sleep
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

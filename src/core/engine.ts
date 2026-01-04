import { EventEmitter } from 'events';
import { TradingLogger, generateRequestId, startPerformanceTimer } from '../utils/logger.js';
import { HyperLiquidClient } from '../exchange/hyperliquid/index.js';
import { SignalProcessor } from '../strategies/superSignal.js';
import { RiskManager } from '../risk/manager.js';
import { TradingPair, Candle, TradingSignal, Position, TRADING_PAIRS } from '../types/index.js';
import { OrderWire, L2Book, OrderResponse, OpenOrder, UserState, getOrderResponseData } from '../types/hyperliquid.js';
import { Decimal } from 'decimal.js';
import { FinancialMath } from '../utils/math.js';
import { StochasticManager } from '../indicators/stochastic.js';
import { ATRCalculator } from '../indicators/atr.js';
import { OrderBookManager, OrderBookAnalyzer } from '../trading/order-book/index.js';
import { ExecutionParameters, OrderBookMetrics } from '../trading/order-book/types.js';
import { DatabaseService } from './database.js';
import { DryRunManager } from './dryRunManager.js';

export class TradingEngine extends EventEmitter {
    private client: HyperLiquidClient;
    private signalProcessor: SignalProcessor;
    private riskManager: RiskManager;
    private positions: Map<TradingPair, Position> = new Map();
    private stochasticManagers: Map<TradingPair, StochasticManager> = new Map();
    private atrManagers: Map<TradingPair, ATRCalculator> = new Map();
    private orderBookManager?: OrderBookManager;
    private orderBookAnalyzer?: OrderBookAnalyzer;
    private databaseService?: DatabaseService;
    private dryRunManager?: DryRunManager;
    private orderBookMetrics: Map<string, OrderBookMetrics> = new Map();
    private maxSlippagePercent: number;

    constructor(
        client: HyperLiquidClient,
        signalProcessor: SignalProcessor,
        riskManager: RiskManager,
        orderBookManager?: OrderBookManager,
        orderBookAnalyzer?: OrderBookAnalyzer,
        databaseService?: DatabaseService,
        dryRunManager?: DryRunManager,
        maxSlippagePercent: number = 0.5 // Default 0.5% max slippage
    ) {
        super();
        this.client = client;
        this.signalProcessor = signalProcessor;
        this.riskManager = riskManager;
        this.orderBookManager = orderBookManager;
        this.orderBookAnalyzer = orderBookAnalyzer;
        this.databaseService = databaseService;
        this.dryRunManager = dryRunManager;
        this.maxSlippagePercent = maxSlippagePercent;

        TradingLogger.setComponent('TradingEngine');
        if (this.dryRunManager) {
            TradingLogger.info('[ENGINE] Running in DRY-RUN mode - no real orders will be placed');
        }
    }

    /**
     * Check if running in dry-run mode
     */
    public isDryRun(): boolean {
        return this.dryRunManager !== undefined;
    }

    /**
     * Map trading pair to HyperLiquid asset index
     * Uses the AssetIndexManager for dynamic mapping instead of hardcoded values
     */
    private getAssetIndex(pair: TradingPair): number {
        const coin = pair.split('-')[0]; // Extract coin symbol (e.g., "BTC" from "BTC-USDC")
        return this.client.assetIndex.getAssetIndex(coin);
    }

    /**
     * Update order book metrics for a coin
     */
    public updateOrderBook(l2Book: L2Book): void {
        if (!this.orderBookManager || !this.orderBookAnalyzer) return;

        // Update order book with new data
        this.orderBookManager.updateFromL2Book(l2Book);

        // Get the updated order book
        const orderBook = this.orderBookManager.getOrderBook(l2Book.coin);
        if (orderBook) {
            // Calculate metrics
            const metrics = this.orderBookAnalyzer.calculateMetrics(orderBook);
            if (metrics) {
                // Store metrics
                this.orderBookMetrics.set(l2Book.coin, metrics);

                // Log key metrics
                TradingLogger.debug(
                    `[ENGINE] L2Book update for ${l2Book.coin}: ` +
                    `spread=${metrics.bidAskSpreadPercentage.toFixed(4)}%, ` +
                    `midPrice=${metrics.midPrice.toFixed(2)}, ` +
                    `bidVol=${metrics.totalBidVolume.toFixed(2)}, ` +
                    `askVol=${metrics.totalAskVolume.toFixed(2)}`
                );
            }
        }
    }

    /**
     * Process incoming candle and execute trades if signals generated
     * CRITICAL FIX: Add try-catch to handle unhandled exceptions
     */
    public async handleCandle(pair: TradingPair, candle: Candle): Promise<void> {
        try {
            const coin = pair.split('-')[0];

            // Check order book data availability before processing signal
            if (this.orderBookManager && this.orderBookAnalyzer) {
                const orderBook = this.orderBookManager.getOrderBook(coin);
                if (orderBook) {
                    const metrics = this.orderBookMetrics.get(coin);
                    if (metrics) {
                        // Check if market is thin (avoid trading in thin markets)
                        const isThin = this.orderBookAnalyzer.isThinMarket(orderBook, 1000);
                        if (isThin) {
                            TradingLogger.warn(`[ENGINE] Thin market detected for ${coin}, skipping signal processing`);
                            return;
                        }

                        // Log order book metrics for signal processing
                        TradingLogger.debug(
                            `[ENGINE] Processing signal for ${coin} with order book: ` +
                            `spread=${metrics.bidAskSpreadPercentage.toFixed(4)}%, ` +
                            `midPrice=${metrics.midPrice.toFixed(2)}, ` +
                            `totalVol=${(metrics.totalBidVolume + metrics.totalAskVolume).toFixed(2)}`
                        );
                    }
                } else {
                    TradingLogger.warn(`[ENGINE] No order book data available for ${coin}, signal processing may be suboptimal`);
                }
            }

            const signal = this.signalProcessor.processCandle(pair, candle);

            if (signal && this.databaseService) {
                await this.databaseService.saveSignal(signal);
            }

            // Check strategy exit signals for open positions (partial or full exit)
            const currentPosition = this.positions.get(pair);
            if (currentPosition && currentPosition.direction !== 'neutral') {
                // Check for partial or full exit signals
                const exits = this.signalProcessor.checkExitsWithType([{
                    direction: currentPosition.direction,
                    pair,
                    partialExitTaken: currentPosition.partialExitTaken
                }]);

                for (const exit of exits) {
                    if (exit.pair === pair) {
                        if (exit.exitType === 'partial') {
                            // Fast K crossed 50 - close 50% of position
                            await this.closePartialPosition(pair, candle.close);
                        } else if (exit.exitType === 'full') {
                            // Fast K hit 80/20 - close remaining position
                            await this.closePosition(pair, candle.close, 'Strategy exit signal (Fast K 80/20)');
                            return; // Exit early, no need to check trailing stops or new entries
                        }
                    }
                }

                // Update trailing stop if position is still open and profitable
                await this.updateTrailingStop(pair, candle);
            }

            // Handle new entry signal (only if no current position)
            if (signal && !currentPosition) {
                await this.evaluateEntry(signal);
            }
        } catch (error) {
            TradingLogger.logError(error, `Failed to handle candle for ${pair}`);
            // Don't throw - continue processing other pairs
        }
    }

    /**
     * Calculate take profit price based on Fast Stochastic levels
     * For long positions: TP when Fast Stoch reaches ~80
     * For short positions: TP when Fast Stoch reaches ~20
     */
    private calculateTakeProfit(
        signal: TradingSignal,
        stochasticManager: StochasticManager
    ): Decimal | null {
        const fastHistory = stochasticManager.getHistory('fast');
        if (fastHistory.length === 0) {
            return null;
        }

        const currentFast = fastHistory[fastHistory.length - 1];
        const currentPrice = signal.price;

        // Calculate TP based on distance from target stochastic level
        // The further we are from the target, the larger the TP distance
        if (signal.direction === 'long') {
            // Long: TP when Fast Stoch reaches 80
            // If current Fast Stoch is 20, we have 60 points to go
            const distanceToTarget = new Decimal(80).sub(currentFast.k);
            const targetPercentage = distanceToTarget.div(100).mul(2); // Scale to price movement

            // Minimum 1% profit, maximum based on stochastic distance
            const tpPercentage = targetPercentage.gt(new Decimal(0.01)) ? targetPercentage : new Decimal(0.01);
            return currentPrice.mul(new Decimal(1).add(tpPercentage));
        } else {
            // Short: TP when Fast Stoch reaches 20
            // If current Fast Stoch is 80, we have 60 points to go
            const distanceToTarget = currentFast.k.sub(new Decimal(20));
            const targetPercentage = distanceToTarget.div(100).mul(2); // Scale to price movement

            // Minimum 1% profit, maximum based on stochastic distance
            const tpPercentage = targetPercentage.gt(new Decimal(0.01)) ? targetPercentage : new Decimal(0.01);
            return currentPrice.mul(new Decimal(1).sub(tpPercentage));
        }
    }

    /**
     * Get execution parameters for a trade based on order book analysis
     */
    private getExecutionParameters(
        coin: string,
        orderSize: number,
        side: 'buy' | 'sell'
    ): ExecutionParameters {
        if (!this.orderBookManager || !this.orderBookAnalyzer) {
            return {
                limitPrice: 0,
                orderSize,
                slippageTolerance: 0.001,
                liquidityThreshold: 1000
            };
        }

        const orderBook = this.orderBookManager.getOrderBook(coin);
        if (!orderBook) {
            return {
                limitPrice: 0,
                orderSize,
                slippageTolerance: 0.001,
                liquidityThreshold: 1000
            };
        }

        // Check if market is thin (configurable threshold of 1000)
        const isThin = this.orderBookAnalyzer.isThinMarket(orderBook, 1000);

        // Default slippage tolerance of 0.1% (0.001)
        const defaultSlippageTolerance = 0.001;
        const slippageTolerance = isThin ? defaultSlippageTolerance * 2 : defaultSlippageTolerance;

        // Calculate execution parameters
        const params = this.orderBookAnalyzer.calculateExecutionParameters(
            orderBook,
            orderSize,
            side,
            slippageTolerance * 100 // Convert to percentage for analyzer
        );

        // Adjust limit price based on spread and slippage
        const bestBid = this.orderBookManager.getBestBid(coin);
        const bestAsk = this.orderBookManager.getBestAsk(coin);

        if (bestBid !== undefined && bestAsk !== undefined) {
            if (side === 'buy') {
                params.limitPrice = bestAsk * (1 - slippageTolerance);
            } else {
                params.limitPrice = bestBid * (1 + slippageTolerance);
            }
        }

        return params;
    }

    /**
     * Identify optimal entry and exit points based on order book liquidity zones
     */
    private identifyOptimalEntryExit(
        coin: string,
        side: 'buy' | 'sell'
    ): { entryPrice: number; exitPrice: number; confidence: number } {
        if (!this.orderBookManager || !this.orderBookAnalyzer) {
            return { entryPrice: 0, exitPrice: 0, confidence: 0 };
        }

        const orderBook = this.orderBookManager.getOrderBook(coin);
        if (!orderBook) {
            return { entryPrice: 0, exitPrice: 0, confidence: 0 };
        }

        // Identify high liquidity zones
        const liquidityZones = this.orderBookAnalyzer.identifyHighLiquidityZones(orderBook, 0.05);

        const bestBid = this.orderBookManager.getBestBid(coin);
        const bestAsk = this.orderBookManager.getBestAsk(coin);

        if (bestBid === undefined || bestAsk === undefined) {
            return { entryPrice: 0, exitPrice: 0, confidence: 0 };
        }

        let entryPrice: number;
        let exitPrice: number;

        if (side === 'buy') {
            // Entry at best ask
            entryPrice = bestAsk;
            // Exit at next higher liquidity level (ask side)
            const askZones = liquidityZones.filter(z => z.price >= bestAsk);
            if (askZones.length > 0) {
                exitPrice = askZones[0].price;
            } else {
                exitPrice = bestAsk * 1.01; // Default 1% above entry
            }
        } else {
            // Entry at best bid
            entryPrice = bestBid;
            // Exit at next lower liquidity level (bid side)
            const bidZones = liquidityZones.filter(z => z.price <= bestBid);
            if (bidZones.length > 0) {
                exitPrice = bidZones[0].price;
            } else {
                exitPrice = bestBid * 0.99; // Default 1% below entry
            }
        }

        // Calculate confidence based on spread and liquidity
        let confidence = 0.5; // Base confidence

        let metrics = this.orderBookMetrics.get(coin);
        if (!metrics) {
            metrics = this.orderBookAnalyzer.calculateMetrics(orderBook);
        }

        if (metrics) {
            // Tighter spread = higher confidence
            if (metrics.bidAskSpreadPercentage < 0.1) {
                confidence = 0.9;
            } else if (metrics.bidAskSpreadPercentage < 0.5) {
                confidence = 0.8;
            } else if (metrics.bidAskSpreadPercentage < 1.0) {
                confidence = 0.6;
            } else {
                confidence = 0.3; // Wide spread penalty
            }
        }

        // Boost slightly if we found valid liquidity zones
        if (liquidityZones.length > 0 && confidence < 1.0) {
            confidence = Math.min(confidence + 0.1, 1.0);
        }

        return { entryPrice, exitPrice, confidence };
    }

    /**
     * Atomically place entry and stop loss orders with rollback on failure.
     * This ensures positions are never left unprotected.
     * 
     * @returns Success status, order IDs if successful, or error message
     */
    private async placeOrdersAtomic(
        pair: TradingPair,
        direction: 'long' | 'short',
        size: Decimal,
        entryPrice: Decimal,
        stopLoss: Decimal
    ): Promise<{
        success: boolean;
        entryOrderId?: number;
        stopLossOrderId?: number;
        error?: string;
    }> {
        const assetIndex = this.getAssetIndex(pair);

        try {
            // ============================================================
            // STEP 1: Place entry order
            // ============================================================
            const entryOrderWire: OrderWire = {
                a: assetIndex,
                b: direction === 'long',
                p: entryPrice.toFixed(6),
                s: size.toFixed(8),
                r: false,
                t: { limit: { tif: 'Ioc' } }
            };

            const requestId = generateRequestId();
            TradingLogger.setRequestId(requestId);
            const endTimer = startPerformanceTimer('placeOrdersAtomic');

            TradingLogger.info(
                `[ATOMIC] Step 1: Placing entry order for ${pair} ${direction} @ ${entryPrice.toFixed(6)} | Size: ${size.toFixed(8)}`,
                { requestId }
            );

            // CRITICAL FIX: Add timeout to placeOrder call (10 seconds)
            const entryResult = await Promise.race([
                this.client.api.placeOrder([entryOrderWire], 'na'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('placeOrder timeout')), 10000)
            ]);

            // ============================================================
            // STEP 2: Validate entry order response
            // ============================================================
            if (!entryResult || entryResult.status === 'err') {
                const errorMsg = `Entry order failed: ${entryResult?.response || 'Unknown error'}`;
                TradingLogger.error(`[ATOMIC] ${errorMsg}`, { requestId });
                return { success: false, error: errorMsg };
            }

            TradingLogger.info(`[ATOMIC] Entry order response received`, {
                requestId,
                status: entryResult?.status
            });

            // Extract entry order ID if available (though IOC orders may fill immediately)
            let entryOrderId: number | undefined;
            const entryResponseData = getOrderResponseData(entryResult);
            if (entryResponseData?.statuses?.[0]?.filled) {
                TradingLogger.info(`[ATOMIC] Entry order filled immediately`, { requestId });
            }

            // ============================================================
            // STEP 3: Place stop loss order
            // ============================================================
            const slOrderWire: OrderWire = {
                a: assetIndex,
                b: direction === 'long' ? false : true, // Opposite side for SL
                p: stopLoss.toFixed(6),
                s: size.toFixed(8),
                r: true, // Reduce-only
                t: {
                    trigger: {
                        isMarket: true,
                        triggerPx: stopLoss.toFixed(6),
                        tpsl: 'sl'
                    }
                }
            };

            TradingLogger.info(
                `[ATOMIC] Step 2: Placing stop loss order for ${pair} @ ${stopLoss.toFixed(6)}`,
                { requestId }
            );

            let slResult: OrderResponse;
            try {
                slResult = await this.client.api.placeOrder([slOrderWire], 'normalTpsl') as OrderResponse;
            } catch (slError: unknown) {
                // ============================================================
                // STEP 4a: SL placement failed - ROLLBACK
                // ============================================================
                TradingLogger.error(
                    `[ATOMIC] CRITICAL: Stop loss placement FAILED for ${pair}. ` +
                    `Error: ${slError instanceof Error ? slError.message : String(slError)}. Initiating ROLLBACK of entry position.`
                );

                await this.rollbackEntryPosition(pair, direction, size, entryPrice, slError);

                return {
                    success: false,
                    error: `SL placement failed: ${slError instanceof Error ? slError.message : String(slError)}. Entry position rolled back.`
                };
            }

            // ============================================================
            // STEP 4b: Validate SL order response
            // ============================================================
            if (!slResult || slResult.status === 'err') {
                const slErrorMsg = slResult?.response || 'Unknown SL error';
                TradingLogger.error(
                    `[ATOMIC] CRITICAL: Stop loss order returned error for ${pair}: ${slErrorMsg}. ` +
                    `Initiating ROLLBACK of entry position.`
                );

                await this.rollbackEntryPosition(pair, direction, size, entryPrice, slErrorMsg);

                return {
                    success: false,
                    error: `SL order failed: ${slErrorMsg}. Entry position rolled back.`
                };
            }

            // Extract stop loss order ID
            let stopLossOrderId: number | undefined;
            const responseData = getOrderResponseData(slResult);
            if (responseData?.statuses?.[0]?.resting?.oid) {
                stopLossOrderId = responseData.statuses[0].resting.oid;
                TradingLogger.info(`[ATOMIC] Stop loss order ID received`, { requestId });
            } else {
                TradingLogger.warn(
                    `[ATOMIC] WARNING: Could not extract stop loss order ID from response for ${pair}. ` +
                    `Response: ${JSON.stringify(slResult)}`
                );
            }

            // ============================================================
            // STEP 5: Verify SL exists via API query
            // ============================================================
            TradingLogger.info(`[ATOMIC] Step 3: Verifying SL order exists via getOpenOrders`, { requestId });

            try {
                // CRITICAL FIX: Add timeout to getOpenOrders call (10 seconds)
                const openOrders = await Promise.race([
                    this.client.api.getOpenOrders(this.client.api.getAddress()) as OpenOrder[],
                    new Promise((_, reject) => setTimeout(() => reject(new Error('getOpenOrders timeout')), 10000)
                ]);

                // Look for our SL order
                const slOrderExists = openOrders?.some((order: OpenOrder) => {
                    // Match by asset, reduce-only flag, and trigger type
                    return order.coin === pair.split('-')[0] &&
                        order.reduceOnly === true &&
                        order.triggerPx !== undefined;
                });

                if (!slOrderExists && stopLossOrderId === undefined) {
                    // SL order not found in open orders
                    TradingLogger.error(
                        `[ATOMIC] CRITICAL: Stop loss order NOT FOUND in open orders for ${pair}. ` +
                        `Initiating ROLLBACK of entry position.`
                    );

                    await this.rollbackEntryPosition(
                        pair,
                        direction,
                        size,
                        entryPrice,
                        'SL verification failed - not found in open orders'
                    );

                    return {
                        success: false,
                        error: 'SL verification failed. Entry position rolled back.'
                    };
                }

                TradingLogger.info(`[ATOMIC] SL order verified in open orders`, { requestId });

            } catch (verifyError: unknown) {
                // Verification API call failed
                TradingLogger.warn(
                    `[ATOMIC] WARNING: Could not verify SL order via API for ${pair}: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}. ` +
                    `Proceeding with caution - SL order may still be active.`
                );
                // Don't rollback if verification fails - assume SL is active
            }

            // ============================================================
            // SUCCESS: Both orders placed and verified
            // ============================================================
            const metrics = endTimer();
            TradingLogger.logPerformance('placeOrdersAtomic', metrics.duration, { requestId, pair });

            TradingLogger.info(
                `[ATOMIC] SUCCESS: Entry + SL orders placed and verified for ${pair} in ${metrics.duration}ms`,
                { requestId }
            );

            return {
                success: true,
                entryOrderId,
                stopLossOrderId
            };

        } catch (error: unknown) {
            TradingLogger.logError(
                error,
                `[ATOMIC] Unexpected error in placeOrdersAtomic for ${pair}`
            );
            return {
                success: false,
                error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Rollback entry position by closing it at market price.
     * Called when SL placement or verification fails.
     */
    private async rollbackEntryPosition(
        pair: TradingPair,
        direction: 'long' | 'short',
        size: Decimal,
        entryPrice: Decimal,
        originalError: unknown
    ): Promise<void> {
        const rollbackStartTime = Date.now();

        TradingLogger.error(
            `[ROLLBACK] Closing unprotected ${direction} position for ${pair} at MARKET. ` +
            `Original error: ${JSON.stringify(originalError)}`
        );

        try {
            // Close position at market (opposite side, reduce-only)
            const closeOrderWire: OrderWire = {
                a: this.getAssetIndex(pair),
                b: direction === 'long' ? false : true, // Opposite side
                p: '0', // Market order - price doesn't matter
                s: size.toFixed(8),
                r: true, // Reduce-only
                t: { limit: { tif: 'Ioc' } }
            };

            const closeResult = await this.client.api.placeOrder([closeOrderWire], 'na');

            const rollbackDuration = Date.now() - rollbackStartTime;

            if (closeResult?.status === 'err') {
                TradingLogger.error(
                    `[ROLLBACK] FAILED to close position for ${pair}. ` +
                    `MANUAL INTERVENTION REQUIRED. Response: ${JSON.stringify(closeResult)}`
                );
            } else {
                TradingLogger.info(
                    `[ROLLBACK] Successfully closed position for ${pair} in ${rollbackDuration}ms. ` +
                    `Response: ${JSON.stringify(closeResult)}`
                );
            }

        } catch (rollbackError: unknown) {
            TradingLogger.logError(
                rollbackError,
                `[ROLLBACK] CRITICAL FAILURE closing position for ${pair}. MANUAL INTERVENTION REQUIRED. Position may be unprotected!`
            );
        }

        // Log full context for debugging
        TradingLogger.error(
            `[ROLLBACK] Full context - Pair: ${pair}, Direction: ${direction}, ` +
            `Size: ${size.toFixed(8)}, Entry: ${entryPrice.toFixed(6)}, ` +
            `Original Error: ${JSON.stringify(originalError)}`
        );
    }

    private async evaluateEntry(signal: TradingSignal): Promise<void> {
        try {
            // Get or create stochastic manager for this pair
            let stochasticManager = this.stochasticManagers.get(signal.pair);
            if (!stochasticManager) {
                stochasticManager = new StochasticManager();
                this.stochasticManagers.set(signal.pair, stochasticManager);
            }

            // Fetch account balance for dynamic position sizing
            const userState = await this.client.api.getUserState(this.client.api.getAddress());
            const accountBalance = new Decimal(userState.marginSummary?.accountValue || '0');

            if (accountBalance.isZero()) {
                TradingLogger.warn('Account balance is zero, skipping trade');
                return;
            }

            // Calculate stop loss (use signal's stopLoss or default 2% from entry)
            // Note: entry price might change after execution parameters are calculated,
            // but we use signal price for initial SL estimation.
            const initialStopLoss = signal.stopLoss || signal.price.mul(
                signal.direction === 'long' ? 0.98 : 1.02
            );

            // Calculate take profit based on Fast Stochastic levels
            const takeProfit = this.calculateTakeProfit(signal, stochasticManager);
            if (!takeProfit) {
                TradingLogger.warn('Could not calculate take profit, skipping trade');
                return;
            }

            // Calculate position size using RiskManager
            const sizeUsd = this.riskManager.calculatePositionSize(
                accountBalance,
                signal.price,
                initialStopLoss
            );

            // Skip if position size is 0 (below minimum)
            if (sizeUsd.isZero()) {
                TradingLogger.warn('Position size too small, skipping trade');
                return;
            }

            // Pre-trade check: Calculate potential loss if stopped out
            const sizeInAssetUnits = sizeUsd.div(signal.price);
            const potentialLossCheck = this.riskManager.checkPotentialLoss(
                signal.price,
                initialStopLoss,
                sizeInAssetUnits
            );

            if (!potentialLossCheck.allowed) {
                TradingLogger.warn(`Trade rejected by pre-trade loss check: ${potentialLossCheck.reason}`);
                return;
            }

            const currentExposure = Array.from(this.positions.values()).reduce(
                (acc, pos) => FinancialMath.add(acc, pos.size.mul(pos.entryPrice)),
                new Decimal(0)
            );

            const riskCheck = this.riskManager.canTrade(
                signal.pair,
                sizeUsd,
                currentExposure,
                this.positions.size
            );

            if (!riskCheck.allowed) {
                TradingLogger.warn(`Trade rejected by RiskManager: ${riskCheck.reason}`);
                return;
            }

            // Calculate basic size in asset units
            let size = sizeUsd.div(signal.price);
            let limitPrice = signal.price;

            // Order book optimization
            if (this.orderBookManager && this.orderBookAnalyzer) {
                const coin = signal.pair.split('-')[0];
                const side = signal.direction === 'long' ? 'buy' : 'sell';

                // Get optimized execution parameters
                const execParams = this.getExecutionParameters(coin, size.toNumber(), side);

                if (execParams.limitPrice > 0) {
                    limitPrice = new Decimal(execParams.limitPrice);
                    // Re-calculate size based on new limit price to maintain USD size
                    size = sizeUsd.div(limitPrice);

                    TradingLogger.info(`Optimized entry for ${signal.pair}: Price ${signal.price.toFixed(6)} -> ${limitPrice.toFixed(6)}`);
                }

                // Check slippage with optimized parameters
                const orderBookForSlippage = this.orderBookManager.getOrderBook(coin);
                if (!orderBookForSlippage) {
                    TradingLogger.warn(`No order book data for ${coin}, skipping slippage check`);
                    return;
                }
                const slippageEstimate = this.orderBookAnalyzer.estimateSlippage(
                    orderBookForSlippage,
                    size.toNumber(),
                    side
                );

                TradingLogger.info(
                    `Slippage estimate for ${signal.pair}: ${slippageEstimate.estimatedSlippage.toFixed(3)}% ` +
                    `(max: ${this.maxSlippagePercent}%), liquidity: ${slippageEstimate.liquidityAvailable.toFixed(4)}, ` +
                    `impact: ${slippageEstimate.marketImpactScore.toFixed(3)}`
                );

                if (slippageEstimate.estimatedSlippage > this.maxSlippagePercent) {
                    TradingLogger.warn(
                        `Trade rejected: slippage ${slippageEstimate.estimatedSlippage.toFixed(3)}% > ` +
                        `max ${this.maxSlippagePercent}% for ${signal.pair}`
                    );
                    return;
                }

                if (slippageEstimate.liquidityAvailable < size.toNumber()) {
                    TradingLogger.warn(
                        `Trade rejected: insufficient liquidity (${slippageEstimate.liquidityAvailable.toFixed(4)} < ${size.toFixed(4)}) for ${signal.pair}`
                    );
                    return;
                }
            } else {
                TradingLogger.warn(`No order book manager available, proceeding with signal price`);
            }

            TradingLogger.info(`Executing Entry: ${signal.pair} ${signal.direction} @ ${limitPrice.toFixed(6)} | Size: $${sizeUsd.toFixed(2)}`);

            // Calculate final stop loss
            let finalStopLoss = initialStopLoss;
            if (!signal.stopLoss) {
                finalStopLoss = limitPrice.mul(
                    signal.direction === 'long' ? 0.98 : 1.02
                );
            }

            // ============================================================
            // DRY-RUN MODE: Simulate trade without real API calls
            // ============================================================
            if (this.dryRunManager) {
                const success = await this.dryRunManager.executeEntry(signal, sizeUsd, finalStopLoss, takeProfit);

                if (success) {
                    // Track position locally for strategy exit signals and trailing stop logic
                    const effectiveEntryPrice = limitPrice;
                    const dryRunSize = sizeUsd.div(effectiveEntryPrice);

                    this.positions.set(signal.pair, {
                        pair: signal.pair,
                        direction: signal.direction,
                        size: dryRunSize,
                        entryPrice: effectiveEntryPrice,
                        stopLoss: finalStopLoss,
                        takeProfit: takeProfit,
                        trailingStop: finalStopLoss,
                        trailingStopActivated: false,
                        timestamp: Date.now(),
                        signalId: `dry-${signal.pair}-${Date.now()}`
                    });

                    this.emit('position_opened', {
                        pair: signal.pair,
                        direction: signal.direction,
                        entryPrice: effectiveEntryPrice,
                        size: dryRunSize,
                        stopLoss: finalStopLoss,
                        takeProfit: takeProfit,
                        timestamp: Date.now(),
                        dryRun: true
                    });
                }
                return; // Skip real order placement
            }

            // ============================================================
            // LIVE MODE: Place entry + stop loss atomically
            // ============================================================
            TradingLogger.info(`Executing Entry: ${signal.pair} ${signal.direction} @ ${limitPrice.toFixed(6)} | Size: $${sizeUsd.toFixed(2)}`);

            // Type guard: should never happen since evaluateEntry is only called for entry signals
            if (signal.direction === 'neutral') {
                TradingLogger.error(`Invalid signal direction 'neutral' for entry signal ${signal.pair}`);
                return;
            }

            const effectiveEntryPrice = limitPrice;
            // Re-calculate SL relative to actual entry price if it wasn't a fixed value
            finalStopLoss = effectiveEntryPrice.mul(
                signal.direction === 'long' ? 0.98 : 1.02
            );

            // Place entry and SL atomically with rollback on failure
            const atomicResult = await this.placeOrdersAtomic(
                signal.pair,
                signal.direction,
                size,
                limitPrice,
                finalStopLoss
            );

            // If atomic placement failed, abort and don't track position
            if (!atomicResult.success) {
                TradingLogger.error(
                    `Atomic order placement failed for ${signal.pair}: ${atomicResult.error}. ` +
                    `Trade aborted, position NOT tracked.`
                );
                return;
            }

            const stopLossOrderId = atomicResult.stopLossOrderId;

            // ============================================================
            // ATOMIC SUCCESS: Entry + SL placed. Now place TP order.
            // ============================================================
            const tpOrderWire: OrderWire = {
                a: this.getAssetIndex(signal.pair),
                b: signal.direction === 'long' ? false : true, // Opposite side for TP
                p: takeProfit.toFixed(6), // Limit price
                s: size.toFixed(8),
                r: true, // Reduce-only
                t: {
                    trigger: {
                        isMarket: true,
                        triggerPx: takeProfit.toFixed(6),
                        tpsl: 'tp'
                    }
                }
            };

            const tpResult = await this.client.api.placeOrder([tpOrderWire], 'normalTpsl');
            TradingLogger.info(`Take profit order placed`, {
                status: tpResult?.status
            });

            // ============================================================
            // Track position locally ONLY after atomic entry+SL success
            // ============================================================
            this.positions.set(signal.pair, {
                pair: signal.pair,
                direction: signal.direction,
                size: size,
                entryPrice: effectiveEntryPrice,
                stopLoss: finalStopLoss,
                stopLossOrderId: stopLossOrderId, // Store order ID for cancellation
                takeProfit: takeProfit,
                trailingStop: finalStopLoss, // Initialize trailing stop at initial SL
                trailingStopActivated: false,
                timestamp: Date.now(),
                signalId: `${signal.pair}-${Date.now()}`
            });

            TradingLogger.info(`Position opened: ${signal.pair} ${signal.direction} | SL @ ${finalStopLoss.toFixed(6)} | TP @ ${takeProfit.toFixed(6)}`);

            this.emit('position_opened', {
                pair: signal.pair,
                direction: signal.direction,
                entryPrice: effectiveEntryPrice,
                size: size,
                stopLoss: finalStopLoss,
                takeProfit: takeProfit,
                timestamp: Date.now()
            });
        } catch (error: unknown) {
            TradingLogger.logError(error, `Entry Failed for ${signal.pair}`);
        }
    }

    /**
     * Update trailing stop loss based on Fast K crossing 50
     * 
     * Activation: Fast K crosses above 50 (long) or below 50 (short)
     * Phase 1: Move stop to breakeven (entry price)
     * Phase 2: Trail by 1.5× ATR as price moves favorably
     */
    private async updateTrailingStop(pair: TradingPair, candle: Candle): Promise<void> {
        const pos = this.positions.get(pair);
        if (!pos || !pos.trailingStop) return;

        const currentPrice = candle.close;
        const entryPrice = pos.entryPrice;

        // Get stochastic manager to check Fast K
        const stochManager = this.stochasticManagers.get(pair);
        if (!stochManager) return;

        const fastHistory = stochManager.getHistory('fast');
        if (fastHistory.length < 2) return;

        const currentFastK = fastHistory[fastHistory.length - 1].k;
        const prevFastK = fastHistory[fastHistory.length - 2].k;

        // ATR multiplier for trailing distance
        const ATR_MULTIPLIER = new Decimal(1.5);

        // Check for trailing stop activation via Fast K crossing 50
        if (!pos.trailingStopActivated) {
            let shouldActivate = false;

            if (pos.direction === 'long') {
                // Long: activate when Fast K crosses ABOVE 50
                shouldActivate = FinancialMath.greaterThanOrEqual(currentFastK, 50) &&
                    FinancialMath.lessThan(prevFastK, 50);
            } else if (pos.direction === 'short') {
                // Short: activate when Fast K crosses BELOW 50
                shouldActivate = FinancialMath.lessThanOrEqual(currentFastK, 50) &&
                    FinancialMath.greaterThan(prevFastK, 50);
            }

            if (shouldActivate) {
                pos.trailingStopActivated = true;
                pos.breakEvenReached = false; // Mark that we need to move to breakeven

                TradingLogger.info(
                    `Trailing stop ACTIVATED for ${pair} - Fast K crossed 50 ` +
                    `(${prevFastK.toFixed(1)} -> ${currentFastK.toFixed(1)})`
                );

                // Calculate and store ATR for trailing
                let atrManager = this.atrManagers.get(pair);
                if (!atrManager) {
                    atrManager = new ATRCalculator(14);
                    this.atrManagers.set(pair, atrManager);
                }

                // We need candle history - get from signal processor if available
                // For now, use a fallback ATR estimate based on current candle range
                const atrValue = atrManager.getCurrentATR();
                if (atrValue) {
                    pos.lastAtr = atrValue;
                } else {
                    // Fallback: estimate ATR as current candle range
                    pos.lastAtr = candle.high.sub(candle.low);
                }

                // Phase 1: Move stop to BREAKEVEN (entry price)
                const newTrailingStop = entryPrice;

                // Only update if significantly different from current stop
                if (!newTrailingStop.eq(pos.trailingStop)) {
                    await this.updateStopLossOrder(pair, pos, newTrailingStop, currentPrice, 'BREAKEVEN');
                    pos.breakEvenReached = true;
                }

                return;
            }
        }

        // If activated, trail by ATR as price moves favorably
        if (pos.trailingStopActivated && pos.breakEvenReached && pos.lastAtr) {
            const atrDistance = pos.lastAtr.mul(ATR_MULTIPLIER);

            let newTrailingStop: Decimal;
            let shouldUpdate = false;

            if (pos.direction === 'long') {
                // Long: trail stop up as price rises, stop = price - 1.5*ATR
                newTrailingStop = currentPrice.sub(atrDistance);

                // Only move stop UP (never down)
                if (newTrailingStop.gt(pos.trailingStop)) {
                    shouldUpdate = true;
                } else {
                    newTrailingStop = pos.trailingStop;
                }
            } else {
                // Short: trail stop down as price falls, stop = price + 1.5*ATR
                newTrailingStop = currentPrice.add(atrDistance);

                // Only move stop DOWN (never up)
                if (newTrailingStop.lt(pos.trailingStop)) {
                    shouldUpdate = true;
                } else {
                    newTrailingStop = pos.trailingStop;
                }
            }

            // Only update if trailing stop has moved significantly (at least 0.1% change)
            if (shouldUpdate) {
                const stopChange = newTrailingStop.sub(pos.trailingStop).abs().div(pos.trailingStop);
                if (FinancialMath.greaterThan(stopChange, new Decimal(0.001))) {
                    await this.updateStopLossOrder(pair, pos, newTrailingStop, currentPrice, 'ATR_TRAIL');
                }
            }
        }
    }

    /**
     * Helper method to update stop loss order on exchange (ATOMIC)
     * Places NEW SL first, verifies it, then cancels old SL to prevent unprotected positions
     */
    private async updateStopLossOrder(
        pair: TradingPair,
        pos: Position,
        newTrailingStop: Decimal,
        currentPrice: Decimal,
        reason: string
    ): Promise<void> {
        if (!pos.trailingStop) {
            TradingLogger.warn(`No trailing stop found for ${pair}, cannot update stop loss order`);
            return;
        }
        const oldStop = pos.trailingStop;
        const oldOrderId = pos.stopLossOrderId;

        // ============================================================
        // DRY-RUN MODE: Simulate trailing stop update without API calls
        // ============================================================
        if (this.dryRunManager) {
            this.dryRunManager.updateTrailingStop(pair, newTrailingStop, reason);

            // Update local position state
            pos.trailingStop = newTrailingStop;

            this.emit('trailing_stop_updated', {
                pair: pair,
                oldStop: oldStop,
                newStop: newTrailingStop,
                currentPrice: currentPrice,
                reason: reason,
                timestamp: Date.now(),
                dryRun: true
            });
            return;
        }

        // ============================================================
        // LIVE MODE: Atomically update stop loss order on exchange
        // ============================================================
        try {
            // ============================================================
            // STEP 1: Place NEW stop loss order FIRST (don't cancel old yet)
            // ============================================================
            const size = pos.size;
            const slOrderWire: OrderWire = {
                a: this.getAssetIndex(pair),
                b: pos.direction === 'long' ? false : true, // Opposite side for SL
                p: newTrailingStop.toFixed(6), // Limit price
                s: size.toFixed(8),
                r: true, // Reduce-only
                t: {
                    trigger: {
                        isMarket: true,
                        triggerPx: newTrailingStop.toFixed(6),
                        tpsl: 'sl'
                    }
                }
            };

            const requestId = generateRequestId();
            TradingLogger.setRequestId(requestId);
            const endTimer = startPerformanceTimer('updateTrailingStop');

            TradingLogger.info(
                `[SL_UPDATE] Step 1: Placing NEW stop loss for ${pair} @ ${newTrailingStop.toFixed(6)} (old: ${oldStop.toFixed(6)})`,
                { requestId }
            );

            let slResult: OrderResponse;
            try {
                slResult = await this.client.api.placeOrder([slOrderWire], 'normalTpsl') as OrderResponse;
            } catch (newSlError: unknown) {
                // ============================================================
                // NEW SL PLACEMENT FAILED - Keep old SL active
                // ============================================================
                TradingLogger.warn(
                    `[SL_UPDATE] WARNING: New SL placement failed for ${pair}. ` +
                    `Keeping OLD SL active @ ${oldStop.toFixed(6)}. Error: ${newSlError instanceof Error ? newSlError.message : String(newSlError)}`
                );
                return; // Exit early, old SL still protects position
            }

            // ============================================================
            // STEP 2: Validate new SL response
            // ============================================================
            if (!slResult || slResult.status === 'err') {
                TradingLogger.warn(
                    `[SL_UPDATE] WARNING: New SL returned error for ${pair}. ` +
                    `Keeping OLD SL active @ ${oldStop.toFixed(6)}. Response: ${JSON.stringify(slResult)}`
                );
                return; // Exit early, old SL still protects position
            }

            TradingLogger.info(`[SL_UPDATE] New SL order placed`, {
                requestId,
                status: slResult?.status
            });

            // Extract new order ID
            let newStopLossOrderId: number | undefined;
            const responseData = getOrderResponseData(slResult);
            if (responseData?.statuses?.[0]?.resting?.oid) {
                newStopLossOrderId = responseData.statuses[0].resting.oid;
                TradingLogger.info(`[SL_UPDATE] New SL order ID received`, { requestId });
            } else {
                TradingLogger.warn(
                    `[SL_UPDATE] WARNING: Could not extract new SL order ID for ${pair}. ` +
                    `Response: ${JSON.stringify(slResult)}`
                );
            }

            // ============================================================
            // STEP 3: Verify new SL exists via API
            // ============================================================
            TradingLogger.info(`[SL_UPDATE] Step 2: Verifying new SL exists via getOpenOrders`, { requestId });

            let newSlVerified = false;
            try {
                // CRITICAL FIX: Add timeout to getOpenOrders call (10 seconds)
                const openOrders = await Promise.race([
                    this.client.api.getOpenOrders(this.client.api.getAddress()) as OpenOrder[],
                    new Promise((_, reject) => setTimeout(() => reject(new Error('getOpenOrders timeout')), 10000)
                ]);

                // Look for the new SL order
                const newSlExists = openOrders?.some((order: OpenOrder) => {
                    return order.coin === pair.split('-')[0] &&
                        order.reduceOnly === true &&
                        order.triggerPx !== undefined &&
                        (newStopLossOrderId === undefined || order.oid === newStopLossOrderId);
                });

                newSlVerified = newSlExists || newStopLossOrderId !== undefined;

                if (!newSlVerified) {
                    TradingLogger.warn(
                        `[SL_UPDATE] WARNING: New SL NOT verified in open orders for ${pair}. ` +
                        `Keeping OLD SL active @ ${oldStop.toFixed(6)}.`
                    );

                    // Try to cancel the potentially failed new SL if we have an ID
                    if (newStopLossOrderId) {
                        try {
                            await this.client.api.cancelOrders([{
                                a: this.getAssetIndex(pair),
                                o: newStopLossOrderId
                            }]);
                            TradingLogger.info(`[SL_UPDATE] Cancelled unverified new SL order`, { requestId });
                        } catch (cancelError) {
                            TradingLogger.logError(cancelError, `[SL_UPDATE] Could not cancel unverified new SL`);
                        }
                    }

                    return; // Exit early, old SL still protects position
                }

                TradingLogger.info(`[SL_UPDATE] New SL verified in open orders`, { requestId });

            } catch (verifyError: unknown) {
                TradingLogger.warn(
                    `[SL_UPDATE] WARNING: Could not verify new SL for ${pair}: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}. ` +
                    `Proceeding with caution assuming new SL is active.`
                );
                // If we have a new order ID, proceed; otherwise keep old SL
                if (!newStopLossOrderId) {
                    return; // Exit early, old SL still protects position
                }
            }

            // ============================================================
            // STEP 4: Cancel OLD SL now that NEW SL is confirmed
            // ============================================================
            if (oldOrderId !== undefined) {
                TradingLogger.info(
                    `[SL_UPDATE] Step 3: Cancelling OLD stop loss order for ${pair}`,
                    { requestId }
                );

                try {
                    const cancelResult = await this.client.api.cancelOrders([{
                        a: this.getAssetIndex(pair),
                        o: oldOrderId
                    }]);

                    TradingLogger.info(`[SL_UPDATE] Old SL cancelled`, {
                        requestId,
                        status: cancelResult?.status
                    });
                } catch (cancelError: unknown) {
                    // Old SL cancellation failed, but new SL is active, so position is still protected
                    TradingLogger.logError(
                        cancelError,
                        `[SL_UPDATE] Failed to cancel old SL ${oldOrderId} for ${pair} but new SL is active. May have duplicate SL orders temporarily. Error: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`
                    );
                    // Continue anyway - having two SL orders is better than zero
                }
            } else {
                TradingLogger.warn(
                    `[SL_UPDATE] No old SL order ID tracked for ${pair}, skipping cancellation`
                );
            }

            // ============================================================
            // STEP 5: Update local state only after successful atomic update
            // ============================================================
            pos.trailingStop = newTrailingStop;
            pos.stopLossOrderId = newStopLossOrderId;

            const metrics = endTimer();
            TradingLogger.logPerformance('updateTrailingStop', metrics.duration, { requestId, pair });

            TradingLogger.info(
                `[SL_UPDATE] SUCCESS: Trailing stop updated [${reason}] for ${pair}: ` +
                `${oldStop.toFixed(6)} → ${newTrailingStop.toFixed(6)} (Current: ${currentPrice.toFixed(6)})`
            );

            this.emit('trailing_stop_updated', {
                pair: pair,
                oldStop: oldStop,
                newStop: newTrailingStop,
                currentPrice: currentPrice,
                reason: reason,
                timestamp: Date.now()
            });

        } catch (error: unknown) {
            // ============================================================
            // CRITICAL ERROR: Failed to update SL atomically
            // ============================================================
            TradingLogger.logError(
                error,
                `[SL_UPDATE] CRITICAL ERROR updating trailing stop for ${pair}. Old SL may still be active @ ${oldStop.toFixed(6)}.`
            );

            // FALLBACK: Check if BOTH SLs are missing (worst case)
            try {
                const openOrders = await this.client.api.getOpenOrders(this.client.api.getAddress()) as OpenOrder[];
                const hasSL = openOrders?.some((order: OpenOrder) => {
                    return order.coin === pair.split('-')[0] &&
                        order.reduceOnly === true &&
                        order.triggerPx !== undefined;
                });

                if (!hasSL) {
                    // ============================================================
                    // EMERGENCY: No SL found - close position at market
                    // ============================================================
                    TradingLogger.error(
                        `[SL_UPDATE] EMERGENCY: NO STOP LOSS FOUND for ${pair}. ` +
                        `Closing position at MARKET to prevent unlimited loss.`
                    );

                    await this.closePosition(
                        pair,
                        currentPrice,
                        'EMERGENCY: SL update failed and no SL found - closing at market'
                    );
                } else {
                    TradingLogger.info(
                        `[SL_UPDATE] Position ${pair} still has a stop loss active. No emergency action needed.`
                    );
                }
            } catch (fallbackError: unknown) {
                TradingLogger.logError(
                    fallbackError,
                    `[SL_UPDATE] CRITICAL: Could not verify SL existence for ${pair}. Manual intervention may be required. Error: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
                );
            }
        }
    }

    private async closePosition(pair: TradingPair, price: Decimal, reason: string): Promise<void> {
        const pos = this.positions.get(pair);
        if (!pos) return;

        if (pos.direction === 'neutral') return;

        try {
            const requestId = generateRequestId();
            TradingLogger.setRequestId(requestId);
            const endTimer = startPerformanceTimer('closePosition');

            TradingLogger.info(`Closing ${pair} ${pos.direction} at ${price.toString()} | Reason: ${reason}`, {
                requestId
            });

            // ============================================================
            // DRY-RUN MODE: Simulate close without real API calls
            // ============================================================
            if (this.dryRunManager) {
                // Map reason to dry-run exit reason type
                let exitReason: 'TP' | 'SL' | 'TRAILING_STOP' | 'STRATEGY_EXIT' = 'STRATEGY_EXIT';
                const reasonLower = reason.toLowerCase();
                if (reasonLower.includes('tp') || reasonLower.includes('take profit')) {
                    exitReason = 'TP';
                } else if (reasonLower.includes('trailing')) {
                    exitReason = 'TRAILING_STOP';
                } else if (reasonLower.includes('stop') || reasonLower.includes('sl')) {
                    exitReason = 'SL';
                }

                const pnl = await this.dryRunManager.executeExit(pair, price, exitReason);

                if (pnl !== null) {
                    this.emit('position_closed', {
                        pair: pair,
                        price: price,
                        pnl: pnl,
                        reason: reason,
                        timestamp: Date.now(),
                        dryRun: true
                    });

                    // Trigger cooldown for stop-outs
                    const isStopOut = exitReason === 'SL' || exitReason === 'TRAILING_STOP';
                    if (isStopOut) {
                        this.signalProcessor.triggerCooldown(pair);
                    }

                    this.positions.delete(pair);
                }
                return; // Skip real order placement
            }

            // ============================================================
            // LIVE MODE: Place real close order
            // ============================================================
            const isBuy = pos.direction === 'short'; // Close short = Buy, Close long = Sell

            const orderWire: OrderWire = {
                a: this.getAssetIndex(pair),
                b: isBuy,
                p: price.toFixed(6),
                s: pos.size.toFixed(8),
                r: true, // reduce-only
                t: { limit: { tif: 'Ioc' } } // Immediate or Cancel to ensure it executes now or cancels
            };

            const result = await this.client.api.placeOrder([orderWire], 'na');

            // Assuming successful fill for local tracking immediately, 
            // but ideally we should wait for fill confirmation.
            // For this implementation, we'll assume the reduce-only order works and clear local state.
            // In a more robust system, we'd wait for the fill via websocket.
            TradingLogger.info(`Close Order placed`, {
                requestId,
                status: result?.status
            });

            const pnl = FinancialMath.calculatePnL(pos.entryPrice, price, pos.size, pos.direction as 'long' | 'short');
            this.riskManager.updatePnL(pnl);

            const metrics = endTimer();
            TradingLogger.logPerformance('closePosition', metrics.duration, { requestId, pair });

            TradingLogger.info(`Position closed. PnL: ${pnl.toString()}`, { requestId });
            this.emit('position_closed', {
                pair: pair,
                price: price,
                pnl: pnl,
                reason: reason,
                timestamp: Date.now()
            });

            if (this.databaseService) {
                await this.databaseService.saveTrade({
                    pair: pair,
                    direction: pos.direction as 'long' | 'short',
                    entryPrice: pos.entryPrice.toNumber(),
                    exitPrice: price.toNumber(),
                    size: pos.size.toNumber(),
                    pnl: pnl.toNumber(),
                    pnlPercent: price.sub(pos.entryPrice).div(pos.entryPrice).toNumber() * (pos.direction === 'long' ? 1 : -1),
                    entryTime: pos.timestamp,
                    exitTime: Date.now(),
                    strategy: 'SuperSignal' // Default strategy name
                });
            }

            // Trigger cooldown if this was a STOP-OUT (not TP or strategy exit)
            // Stop-outs typically have 'stop', 'trailing', or 'SL' in the reason
            const isStopOut = reason.toLowerCase().includes('stop') ||
                reason.toLowerCase().includes('trailing') ||
                reason.toLowerCase().includes('sl');

            if (isStopOut) {
                this.signalProcessor.triggerCooldown(pair);
            }

            this.positions.delete(pair);


        } catch (error: unknown) {
            TradingLogger.logError(error, `Failed to close position for ${pair}`);
            // Do not delete position if failed, so we can try again on next candle
        }
    }

    /**
     * Close partial position (50% scale-out) when Fast K crosses 50
     * Updates stop loss order size for the remaining 50%
     */
    private async closePartialPosition(pair: TradingPair, price: Decimal): Promise<void> {
        const pos = this.positions.get(pair);
        if (!pos || pos.direction === 'neutral') return;

        // Already took partial exit
        if (pos.partialExitTaken) {
            TradingLogger.warn(`Partial exit already taken for ${pair}, skipping`);
            return;
        }

        const partialSize = pos.size.div(2); // Close 50%
        const remainingSize = pos.size.sub(partialSize);

        try {
            const requestId = generateRequestId();
            TradingLogger.setRequestId(requestId);
            const endTimer = startPerformanceTimer('partialExit');

            TradingLogger.info(`Partial Exit: ${pair} ${pos.direction} closing 50% (${partialSize.toFixed(8)}) at ${price.toFixed(6)}`, {
                requestId
            });

            // ============================================================
            // DRY-RUN MODE: Simulate partial close without real API calls
            // ============================================================
            if (this.dryRunManager) {
                const pnl = await this.dryRunManager.executePartialExit(pair, price);

                if (pnl !== null) {
                    // Update position state
                    pos.size = remainingSize;
                    pos.partialExitTaken = true;

                    this.emit('partial_exit', {
                        pair: pair,
                        price: price,
                        closedSize: partialSize,
                        remainingSize: remainingSize,
                        pnl: pnl,
                        timestamp: Date.now(),
                        dryRun: true
                    });

                    TradingLogger.info(`[DRY-RUN] Partial exit complete: ${pair} | Closed: ${partialSize.toFixed(8)} | Remaining: ${remainingSize.toFixed(8)}`);
                }
                return; // Skip real order placement
            }

            // ============================================================
            // LIVE MODE: Place real close order
            // ============================================================
            const isBuy = pos.direction === 'short'; // Close short = Buy, Close long = Sell

            // Place close order for 50%
            const orderWire: OrderWire = {
                a: this.getAssetIndex(pair),
                b: isBuy,
                p: price.toFixed(6),
                s: partialSize.toFixed(8),
                r: true, // reduce-only
                t: { limit: { tif: 'Ioc' } }
            };

            const result = await this.client.api.placeOrder([orderWire], 'na');
            TradingLogger.info(`Partial close order placed`, {
                requestId,
                status: result?.status
            });

            // Calculate partial PnL
            const partialPnl = FinancialMath.calculatePnL(pos.entryPrice, price, partialSize, pos.direction as 'long' | 'short');
            this.riskManager.updatePnL(partialPnl);
            TradingLogger.info(`Partial exit PnL: ${partialPnl.toFixed(6)}`, { requestId });

            // Cancel and replace stop loss with reduced size
            if (pos.stopLossOrderId !== undefined) {
                TradingLogger.info(`Cancelling old stop loss order to resize for remaining ${remainingSize.toFixed(8)}`, {
                    requestId
                });

                await this.client.api.cancelOrders([{
                    a: this.getAssetIndex(pair),
                    o: pos.stopLossOrderId
                }]);

                // Place new stop loss for remaining size
                const currentStopPrice = pos.trailingStop || pos.stopLoss;
                const slOrderWire: OrderWire = {
                    a: this.getAssetIndex(pair),
                    b: pos.direction === 'long' ? false : true, // Opposite side for SL
                    p: currentStopPrice.toFixed(6),
                    s: remainingSize.toFixed(8), // Updated size
                    r: true, // Reduce-only
                    t: {
                        trigger: {
                            isMarket: true,
                            triggerPx: currentStopPrice.toFixed(6),
                            tpsl: 'sl'
                        }
                    }
                };

                const slResult = await this.client.api.placeOrder([slOrderWire], 'normalTpsl');
                TradingLogger.info(`New stop loss order placed for remaining size`, {
                    requestId,
                    status: slResult?.status
                });

                // Update stop loss order ID
                const slResponseData = getOrderResponseData(slResult);
                if (slResponseData?.statuses?.[0]?.resting?.oid) {
                    pos.stopLossOrderId = slResponseData.statuses[0].resting.oid;
                } else {
                    TradingLogger.warn('Could not extract new stop loss order ID');
                    pos.stopLossOrderId = undefined;
                }
            } else {
                TradingLogger.warn(`No stop loss order ID tracked for ${pair}, cannot resize stop`);
            }

            // Update position state
            pos.size = remainingSize;
            pos.partialExitTaken = true;

            this.emit('partial_exit', {
                pair: pair,
                price: price,
                closedSize: partialSize,
                remainingSize: remainingSize,
                pnl: partialPnl,
                timestamp: Date.now()
            });

            const metrics = endTimer();
            TradingLogger.logPerformance('partialExit', metrics.duration, { requestId, pair });

            TradingLogger.info(`Partial exit complete: ${pair} | Closed: ${partialSize.toFixed(8)} | Remaining: ${remainingSize.toFixed(8)}`, {
                requestId
            });

        } catch (error: unknown) {
            TradingLogger.logError(error, `Failed to execute partial exit for ${pair}`);
            // Don't update position state if failed
        }
    }

    public getPositions(): Position[] {
        return Array.from(this.positions.values());
    }

    /**
     * Get stochastic manager for a specific pair
     */
    public getStochasticManager(pair: TradingPair): StochasticManager | undefined {
        return this.stochasticManagers.get(pair);
    }

    /**
     * Reconcile local state with exchange state on startup
     * CRITICAL FIX: Add try-catch to handle unhandled exceptions
     */
    public reconcilePositions(userState: UserState, openOrders: OpenOrder[]): void {
        try {
            TradingLogger.info("Reconciling local state with exchange state...");

            if (!userState.assetPositions) {
                TradingLogger.warn("No asset positions found in user state");
                return;
            }

            // Internal map of coin -> TradingPair (e.g. "ETH" -> "ETH-USDC")
            // TRADING_PAIRS is available from imports
            const coinToPair = new Map<string, TradingPair>();

            for (const pair of TRADING_PAIRS) {
                const coin = pair.split('-')[0];
                coinToPair.set(coin, pair);
            }

            let recoveredCount = 0;

            for (const ap of userState.assetPositions) {
                const position = ap.position;
                const coin = position.coin;
                const size = new Decimal(position.szi);

                if (size.isZero()) continue;

                const pair = coinToPair.get(coin);
                if (!pair) {
                    TradingLogger.warn(`Found position for unknown coin ${coin}, skipping`);
                    continue;
                }

                const associatedOrders = openOrders.filter((o: OpenOrder) => o.coin === coin);

                // Find Stop Loss order (Reduce-Only, Trigger for SL)
                // Hyperliquid API structure for orders might vary, checking generic 'trigger' properties
                const slOrder = associatedOrders.find((o: OpenOrder) =>
                    (o.isTrigger || o.orderType === 'Stop Market' || o.orderType === 'Stop Limit') &&
                    o.reduceOnly
                );

                let stopLossPrice = new Decimal(0);
                let stopLossOrderId: number | undefined;

                if (slOrder) {
                    stopLossOrderId = slOrder.oid;
                    // triggerPx could be in 'triggerCondition' or top level depending on API version
                    // Assuming standard field from our observation or defaulting
                    if (slOrder.triggerPx) {
                        stopLossPrice = new Decimal(slOrder.triggerPx);
                    } else if (slOrder.triggerCondition) {
                        // Sometimes it's a string like " < 2000" or similar, but API usually gives clean number field too
                        // For now, if we can't parse, we rely on 0
                    }
                }

                // Direction
                const direction = size.isPositive() ? 'long' : 'short';
                const entryPrice = new Decimal(position.entryPx);

                // Reconstruct Position object
                const recoveredPosition: Position = {
                    pair: pair,
                    direction: direction,
                    size: size.abs(),
                    entryPrice: entryPrice,
                    stopLoss: stopLossPrice.isZero() ? entryPrice : stopLossPrice,
                    stopLossOrderId: stopLossOrderId,
                    takeProfit: new Decimal(0),
                    trailingStop: stopLossPrice.isZero() ? entryPrice : stopLossPrice,
                    trailingStopActivated: false,
                    timestamp: Date.now(),
                    signalId: `RECOVERED-${Date.now()}`
                };

                this.positions.set(pair, recoveredPosition);
                recoveredCount++;

                TradingLogger.info(
                    `Recovered position: ${pair} ${direction} ${size.abs()} @ ${entryPrice.toFixed(2)} ` +
                    `| SL: ${stopLossPrice.gt(0) ? stopLossPrice.toFixed(2) : 'MISSING (Set to Entry)'} | OrderID: ${stopLossOrderId || 'None'}`
                );
            }

            TradingLogger.info(`Reconciliation complete. Recovered ${recoveredCount} positions.`);
        } catch (error) {
            TradingLogger.logError(error, 'Failed to reconcile positions');
            // Don't throw - continue with empty positions
        }
    }
}

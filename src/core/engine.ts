import { EventEmitter } from 'events';
import { TradingLogger } from '../utils/logger.js';
import { HyperLiquidClient } from '../exchange/hyperliquid/index.js';
import { SignalProcessor } from '../strategies/superSignal.js';
import { RiskManager } from '../risk/manager.js';
import { TradingPair, Candle, TradingSignal, Position, TRADING_PAIRS } from '../types/index.js';
import { OrderWire } from '../types/hyperliquid.js';
import { Decimal } from 'decimal.js';
import { FinancialMath } from '../utils/math.js';
import { StochasticManager } from '../indicators/stochastic.js';
import { OrderBookManager, OrderBookAnalyzer } from '../trading/order-book/index.js';
import { ExecutionParameters, SlippageEstimate } from '../trading/order-book/types.js';
import { DatabaseService } from './database.js';

export class TradingEngine extends EventEmitter {
    private client: HyperLiquidClient;
    private signalProcessor: SignalProcessor;
    private riskManager: RiskManager;
    private positions: Map<TradingPair, Position> = new Map();
    private stochasticManagers: Map<TradingPair, StochasticManager> = new Map();
    private orderBookManager?: OrderBookManager;
    private orderBookAnalyzer?: OrderBookAnalyzer;
    private databaseService?: DatabaseService;
    private maxSlippagePercent: number;

    constructor(
        client: HyperLiquidClient,
        signalProcessor: SignalProcessor,
        riskManager: RiskManager,
        orderBookManager?: OrderBookManager,
        orderBookAnalyzer?: OrderBookAnalyzer,
        databaseService?: DatabaseService,
        maxSlippagePercent: number = 0.5 // Default 0.5% max slippage
    ) {
        super();
        this.client = client;
        this.signalProcessor = signalProcessor;
        this.riskManager = riskManager;
        this.orderBookManager = orderBookManager;
        this.orderBookAnalyzer = orderBookAnalyzer;
        this.databaseService = databaseService;
        this.maxSlippagePercent = maxSlippagePercent;
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
     * Process incoming candle and execute trades if signals generated
     */
    public async handleCandle(pair: TradingPair, candle: Candle): Promise<void> {
        const signal = this.signalProcessor.processCandle(pair, candle);

        if (signal && this.databaseService) {
            this.databaseService.saveSignal(signal);
        }

        // Check strategy exit signals for open positions
        const currentPosition = this.positions.get(pair);
        if (currentPosition && currentPosition.direction !== 'neutral') {
            // Check if strategy signals an exit (e.g., Stochastic crossing 80/20)
            const positionsToCheck = [{ direction: currentPosition.direction, pair }];
            const pairsToExit = this.signalProcessor.checkExits(positionsToCheck);

            if (pairsToExit.includes(pair)) {
                // Strategy exit signal triggered - close position immediately
                await this.closePosition(pair, candle.close, 'Strategy exit signal');
                return; // Exit early, no need to check trailing stops or new entries
            }

            // Update trailing stop if position is still open and profitable
            await this.updateTrailingStop(pair, candle);
        }

        // Handle new entry signal (only if no current position)
        if (signal && !currentPosition) {
            await this.evaluateEntry(signal);
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

        return { entryPrice, exitPrice, confidence: 0.5 };
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
                const slippageEstimate = this.orderBookAnalyzer.estimateSlippage(
                    this.orderBookManager.getOrderBook(coin)!,
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


            const orderWire: OrderWire = {
                a: this.getAssetIndex(signal.pair),
                b: signal.direction === 'long',
                p: limitPrice.toFixed(6),
                s: size.toFixed(8),
                r: false,
                t: { limit: { tif: 'Ioc' } }
            };

            const result = await this.client.api.placeOrder([orderWire], 'na');
            TradingLogger.info(`Entry order placed: ${JSON.stringify(result)}`);

            // Recalculate Stop Loss based on actual execution price?
            // Ideally yes, but we use the initial estimated SL for now or re-calculate.
            // Let's stick to the initial SL relative to entry price to maintain risk R:R ratio?
            // Actually, if we got a better price, we should probably adjust SL to strictly limit risk or keep same distance.
            // Let's keep the logic simple: SL is fixed value or calculated from signal.
            // But if Limit Price changed, purely percentage based SL needs update.

            const effectiveEntryPrice = limitPrice;
            // Re-calculate SL relative to actual entry price if it wasn't a fixed value
            let finalStopLoss = initialStopLoss;
            if (!signal.stopLoss) {
                finalStopLoss = effectiveEntryPrice.mul(
                    signal.direction === 'long' ? 0.98 : 1.02
                );
            }

            // Place stop loss order using normalTpsl grouping
            const slOrderWire: OrderWire = {
                a: this.getAssetIndex(signal.pair),
                b: signal.direction === 'long' ? false : true, // Opposite side for SL
                p: finalStopLoss.toFixed(6), // Limit price
                s: size.toFixed(8),
                r: true, // Reduce-only
                t: {
                    trigger: {
                        isMarket: true,
                        triggerPx: finalStopLoss.toFixed(6),
                        tpsl: 'sl'
                    }
                }
            };

            const slResult = await this.client.api.placeOrder([slOrderWire], 'normalTpsl');
            TradingLogger.info(`Stop loss order placed: ${JSON.stringify(slResult)}`);

            // Extract order ID from response for future cancellation
            let stopLossOrderId: number | undefined;
            if (slResult?.response?.data?.statuses?.[0]?.resting?.oid) {
                stopLossOrderId = slResult.response.data.statuses[0].resting.oid;
                TradingLogger.info(`Stop loss order ID: ${stopLossOrderId}`);
            } else {
                TradingLogger.warn('Could not extract stop loss order ID from response');
            }

            // Place take profit order using normalTpsl grouping
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
            TradingLogger.info(`Take profit order placed: ${JSON.stringify(tpResult)}`);

            // Track position locally with TP and trailing stop info
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
        } catch (error: any) {
            TradingLogger.error(`Entry Failed: ${error.message}`);
        }
    }

    /**
     * Update trailing stop loss as price moves favorably
     * Trailing stop activates after 1% profit and moves in 0.5% increments
     */
    private async updateTrailingStop(pair: TradingPair, candle: Candle): Promise<void> {
        const pos = this.positions.get(pair);
        if (!pos || !pos.trailingStop) return;

        const currentPrice = candle.close;
        const initialStopLoss = pos.stopLoss;
        const entryPrice = pos.entryPrice;

        // Calculate current profit percentage
        let profitPercentage: Decimal;
        if (pos.direction === 'long') {
            profitPercentage = currentPrice.sub(entryPrice).div(entryPrice);
        } else {
            profitPercentage = entryPrice.sub(currentPrice).div(entryPrice);
        }

        // Trailing stop activation threshold (1% profit)
        const activationThreshold = new Decimal(0.01);

        // Trailing stop increment (0.5%)
        const trailingIncrement = new Decimal(0.005);

        if (FinancialMath.greaterThan(profitPercentage, activationThreshold)) {
            // Position is profitable, activate or update trailing stop
            if (!pos.trailingStopActivated) {
                // First time reaching activation threshold
                pos.trailingStopActivated = true;
                TradingLogger.info(`Trailing stop activated for ${pair} at ${currentPrice.toFixed(6)} (Profit: ${profitPercentage.mul(100).toFixed(2)}%)`);
            }

            // Calculate new trailing stop price
            let newTrailingStop: Decimal;
            if (pos.direction === 'long') {
                // For long: trailing stop moves up as price rises
                // New stop = current price - (entry price * trailing increment * number of increments)
                const profitIncrements = profitPercentage.div(trailingIncrement).floor();
                const trailingDistance = entryPrice.mul(trailingIncrement).mul(profitIncrements);
                newTrailingStop = entryPrice.add(trailingDistance);

                // Ensure trailing stop doesn't move down
                newTrailingStop = newTrailingStop.gt(pos.trailingStop) ? newTrailingStop : pos.trailingStop;
            } else {
                // For short: trailing stop moves down as price falls
                // New stop = current price + (entry price * trailing increment * number of increments)
                const profitIncrements = profitPercentage.div(trailingIncrement).floor();
                const trailingDistance = entryPrice.mul(trailingIncrement).mul(profitIncrements);
                newTrailingStop = entryPrice.sub(trailingDistance);

                // Ensure trailing stop doesn't move up
                newTrailingStop = newTrailingStop.lt(pos.trailingStop) ? newTrailingStop : pos.trailingStop;
            }

            // Only update if trailing stop has moved significantly (at least 0.1% change)
            const stopChange = newTrailingStop.sub(pos.trailingStop).abs().div(pos.trailingStop);
            if (FinancialMath.greaterThan(stopChange, new Decimal(0.001))) {
                const oldStop = pos.trailingStop;

                // Cancel old stop loss order and place new one
                try {
                    // Only attempt cancellation if we have a tracked order ID
                    if (pos.stopLossOrderId !== undefined) {
                        TradingLogger.info(`Cancelling old stop loss order ${pos.stopLossOrderId} for ${pair}`);

                        const cancelResult = await this.client.api.cancelOrders([{
                            a: this.getAssetIndex(pair),
                            o: pos.stopLossOrderId
                        }]);

                        TradingLogger.info(`Cancel order result: ${JSON.stringify(cancelResult)}`);
                    } else {
                        TradingLogger.warn(`No stop loss order ID tracked for ${pair}, cannot cancel old order`);
                    }

                    // Place new stop loss order at updated trailing stop price
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

                    const slResult = await this.client.api.placeOrder([slOrderWire], 'normalTpsl');
                    TradingLogger.info(`New trailing stop order placed: ${JSON.stringify(slResult)}`);

                    // Extract and update the new order ID
                    if (slResult?.response?.data?.statuses?.[0]?.resting?.oid) {
                        pos.stopLossOrderId = slResult.response.data.statuses[0].resting.oid;
                        TradingLogger.info(`New stop loss order ID: ${pos.stopLossOrderId}`);
                    } else {
                        TradingLogger.warn('Could not extract new stop loss order ID from response');
                        pos.stopLossOrderId = undefined;
                    }

                    // Update trailing stop price only after successful order placement
                    pos.trailingStop = newTrailingStop;

                    TradingLogger.info(
                        `Trailing stop updated for ${pair}: ${oldStop.toFixed(6)} -> ${newTrailingStop.toFixed(6)} ` +
                        `(Current: ${currentPrice.toFixed(6)}, Profit: ${profitPercentage.mul(100).toFixed(2)}%)`
                    );

                    this.emit('trailing_stop_updated', {
                        pair: pair,
                        oldStop: oldStop,
                        newStop: newTrailingStop,
                        currentPrice: currentPrice,
                        timestamp: Date.now()
                    });

                } catch (error: any) {
                    TradingLogger.error(`Failed to update trailing stop for ${pair}: ${error.message}`);
                    // Don't update local state if API calls failed
                }
            }
        }
    }

    private async closePosition(pair: TradingPair, price: Decimal, reason: string): Promise<void> {
        const pos = this.positions.get(pair);
        if (!pos) return;

        if (pos.direction === 'neutral') return;

        try {
            const isBuy = pos.direction === 'short'; // Close short = Buy, Close long = Sell

            TradingLogger.info(`Closing ${pair} ${pos.direction} at ${price.toString()} | Reason: ${reason}`);

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
            TradingLogger.info(`Close Order placed: ${JSON.stringify(result)}`);

            const pnl = FinancialMath.calculatePnL(pos.entryPrice, price, pos.size, pos.direction as 'long' | 'short');
            this.riskManager.updatePnL(pnl);

            TradingLogger.info(`Position closed. PnL: ${pnl.toString()}`);
            this.emit('position_closed', {
                pair: pair,
                price: price,
                pnl: pnl,
                reason: reason,
                timestamp: Date.now()
            });

            if (this.databaseService) {
                this.databaseService.saveTrade({
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

            this.positions.delete(pair);

        } catch (error: any) {
            TradingLogger.error(`Failed to close position: ${error.message}`);
            // Do not delete position if failed, so we can try again on next candle
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
     */
    public reconcilePositions(userState: any, openOrders: any[]): void {
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

            const associatedOrders = openOrders.filter((o: any) => o.coin === coin);

            // Find Stop Loss order (Reduce-Only, Trigger for SL)
            // Hyperliquid API structure for orders might vary, checking generic 'trigger' properties
            const slOrder = associatedOrders.find((o: any) =>
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
    }
}

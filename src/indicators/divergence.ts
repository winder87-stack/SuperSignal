// Divergence Detection Module
// Detects bullish and bearish divergence between price and stochastic %D

import { Decimal } from 'decimal.js';
import { Candle, StochasticValue } from '../types/index.js';
import { FinancialMath } from '../utils/math.js';
import { PivotDetector, Pivot } from './pivots.js';

/**
 * Configuration for divergence detection
 */
export interface DivergenceConfig {
    /** Minimum candles required for divergence detection */
    minCandles: number;
    /** Minimum stochastic history values needed */
    minHistorySize: number;
    /** Left bars for pivot detection */
    pivotLeftBars: number;
    /** Right bars for pivot confirmation */
    pivotRightBars: number;
}

/**
 * Signal indicating detected divergence
 */
export interface DivergenceSignal {
    type: 'bullish' | 'bearish';
    strength: Decimal; // 0-1
    pricePoint: Decimal;
    stochasticPoint: Decimal;
}

/**
 * Detailed divergence result with pivot information
 */
export interface DivergenceResult {
    type: 'bullish' | 'bearish';
    strength: Decimal;
    pricePivots: { prev: Pivot; last: Pivot };
    stochPivots: { prev: StochasticValue; last: StochasticValue };
}

/**
 * Default configuration values
 */
export const DEFAULT_DIVERGENCE_CONFIG: DivergenceConfig = {
    minCandles: 50,
    minHistorySize: 20,
    pivotLeftBars: 5,
    pivotRightBars: 2
};

/**
 * DivergenceDetector class for detecting price/stochastic divergence
 * 
 * Bullish Divergence: Price makes lower low, stochastic %D makes higher low
 * Bearish Divergence: Price makes higher high, stochastic %D makes lower high
 */
export class DivergenceDetector {
    private config: DivergenceConfig;
    private pivotDetector: PivotDetector;

    constructor(config: Partial<DivergenceConfig> = {}) {
        this.config = { ...DEFAULT_DIVERGENCE_CONFIG, ...config };
        this.pivotDetector = new PivotDetector(
            this.config.pivotLeftBars,
            this.config.pivotRightBars
        );
    }

    /**
     * Detect divergence between price and stochastic %D
     * @param candles - Price candle data
     * @param stochasticHistory - Historical stochastic values
     * @returns 'bullish' | 'bearish' | null
     */
    public detect(
        candles: Candle[],
        stochasticHistory: StochasticValue[]
    ): 'bullish' | 'bearish' | null {
        if (candles.length < this.config.minCandles) return null;
        if (stochasticHistory.length < this.config.minHistorySize) return null;

        // Get confirmed pivots
        const pivots = this.pivotDetector.detect(candles);
        if (pivots.length < 2) return null;

        const currentPrice = candles[candles.length - 1];
        const currentStoch = stochasticHistory[stochasticHistory.length - 1];

        // Check for bullish divergence first
        const bullish = this.detectBullish(pivots, stochasticHistory, currentPrice, currentStoch);
        if (bullish) return 'bullish';

        // Check for bearish divergence
        const bearish = this.detectBearish(pivots, stochasticHistory, currentPrice, currentStoch);
        if (bearish) return 'bearish';

        return null;
    }

    /**
     * Detect divergence with detailed result including pivot information
     * @param candles - Price candle data
     * @param stochasticHistory - Historical stochastic values
     * @returns DivergenceResult with full details or null
     */
    public detectDetailed(
        candles: Candle[],
        stochasticHistory: StochasticValue[]
    ): DivergenceResult | null {
        if (candles.length < this.config.minCandles) return null;
        if (stochasticHistory.length < this.config.minHistorySize) return null;

        const pivots = this.pivotDetector.detect(candles);
        if (pivots.length < 2) return null;

        const currentPrice = candles[candles.length - 1];
        const currentStoch = stochasticHistory[stochasticHistory.length - 1];

        // Check bullish
        const bullishResult = this.detectBullishDetailed(pivots, stochasticHistory, currentPrice, currentStoch);
        if (bullishResult) return bullishResult;

        // Check bearish
        const bearishResult = this.detectBearishDetailed(pivots, stochasticHistory, currentPrice, currentStoch);
        if (bearishResult) return bearishResult;

        return null;
    }

    /**
     * Detect bullish divergence: Lower Low in Price, Higher Low in Stoch %D
     */
    private detectBullish(
        pivots: Pivot[],
        stochasticHistory: StochasticValue[],
        currentPrice: Candle,
        currentStoch: StochasticValue
    ): boolean {
        const lowPivots = pivots.filter(p => p.type === 'low');
        if (lowPivots.length < 2) return false;

        const lastPivot = lowPivots[lowPivots.length - 1];
        const prevPivot = lowPivots[lowPivots.length - 2];

        const lastPivotStoch = stochasticHistory.find(s => s.timestamp === lastPivot.timestamp);
        const prevPivotStoch = stochasticHistory.find(s => s.timestamp === prevPivot.timestamp);

        if (!lastPivotStoch || !prevPivotStoch) return false;

        // Price: Last Pivot Low < Prev Pivot Low (lower low)
        // Stoch: Last Pivot %D > Prev Pivot %D (higher low)
        // Standard pivot-to-pivot divergence - no continuation check needed
        // Location and stochastic level filters are applied by the strategy
        return FinancialMath.lessThan(lastPivot.price, prevPivot.price) &&
            FinancialMath.greaterThan(lastPivotStoch.d, prevPivotStoch.d);
    }

    /**
     * Detect bearish divergence: Higher High in Price, Lower High in Stoch %D
     */
    private detectBearish(
        pivots: Pivot[],
        stochasticHistory: StochasticValue[],
        currentPrice: Candle,
        currentStoch: StochasticValue
    ): boolean {
        const highPivots = pivots.filter(p => p.type === 'high');
        if (highPivots.length < 2) return false;

        const lastPivot = highPivots[highPivots.length - 1];
        const prevPivot = highPivots[highPivots.length - 2];

        const lastPivotStoch = stochasticHistory.find(s => s.timestamp === lastPivot.timestamp);
        const prevPivotStoch = stochasticHistory.find(s => s.timestamp === prevPivot.timestamp);

        if (!lastPivotStoch || !prevPivotStoch) return false;

        // Price: Last Pivot High > Prev Pivot High (higher high)
        // Stoch: Last Pivot %D < Prev Pivot %D (lower high)
        // Standard pivot-to-pivot divergence - no continuation check needed
        // Location and stochastic level filters are applied by the strategy
        return FinancialMath.greaterThan(lastPivot.price, prevPivot.price) &&
            FinancialMath.lessThan(lastPivotStoch.d, prevPivotStoch.d);
    }

    /**
     * Detect bullish divergence with detailed result
     */
    private detectBullishDetailed(
        pivots: Pivot[],
        stochasticHistory: StochasticValue[],
        currentPrice: Candle,
        currentStoch: StochasticValue
    ): DivergenceResult | null {
        const lowPivots = pivots.filter(p => p.type === 'low');
        if (lowPivots.length < 2) return null;

        const lastPivot = lowPivots[lowPivots.length - 1];
        const prevPivot = lowPivots[lowPivots.length - 2];

        const lastPivotStoch = stochasticHistory.find(s => s.timestamp === lastPivot.timestamp);
        const prevPivotStoch = stochasticHistory.find(s => s.timestamp === prevPivot.timestamp);

        if (!lastPivotStoch || !prevPivotStoch) return null;

        // Standard pivot-to-pivot divergence check
        if (FinancialMath.lessThan(lastPivot.price, prevPivot.price) &&
            FinancialMath.greaterThan(lastPivotStoch.d, prevPivotStoch.d)) {

            // Calculate strength based on divergence magnitude
            const priceDiff = FinancialMath.percentageChange(prevPivot.price, lastPivot.price).abs();
            const stochDiff = lastPivotStoch.d.sub(prevPivotStoch.d).abs();
            const strength = FinancialMath.clamp(
                priceDiff.add(stochDiff.div(100)).div(2),
                0,
                1
            );

            return {
                type: 'bullish',
                strength,
                pricePivots: { prev: prevPivot, last: lastPivot },
                stochPivots: { prev: prevPivotStoch, last: lastPivotStoch }
            };
        }

        return null;
    }

    /**
     * Detect bearish divergence with detailed result
     */
    private detectBearishDetailed(
        pivots: Pivot[],
        stochasticHistory: StochasticValue[],
        currentPrice: Candle,
        currentStoch: StochasticValue
    ): DivergenceResult | null {
        const highPivots = pivots.filter(p => p.type === 'high');
        if (highPivots.length < 2) return null;

        const lastPivot = highPivots[highPivots.length - 1];
        const prevPivot = highPivots[highPivots.length - 2];

        const lastPivotStoch = stochasticHistory.find(s => s.timestamp === lastPivot.timestamp);
        const prevPivotStoch = stochasticHistory.find(s => s.timestamp === prevPivot.timestamp);

        if (!lastPivotStoch || !prevPivotStoch) return null;

        // Standard pivot-to-pivot divergence check
        if (FinancialMath.greaterThan(lastPivot.price, prevPivot.price) &&
            FinancialMath.lessThan(lastPivotStoch.d, prevPivotStoch.d)) {

            // Calculate strength based on divergence magnitude
            const priceDiff = FinancialMath.percentageChange(prevPivot.price, lastPivot.price).abs();
            const stochDiff = prevPivotStoch.d.sub(lastPivotStoch.d).abs();
            const strength = FinancialMath.clamp(
                priceDiff.add(stochDiff.div(100)).div(2),
                0,
                1
            );

            return {
                type: 'bearish',
                strength,
                pricePivots: { prev: prevPivot, last: lastPivot },
                stochPivots: { prev: prevPivotStoch, last: lastPivotStoch }
            };
        }

        return null;
    }

    /**
     * Get current configuration
     */
    public getConfig(): DivergenceConfig {
        return { ...this.config };
    }

    /**
     * Update configuration
     */
    public setConfig(config: Partial<DivergenceConfig>): void {
        this.config = { ...this.config, ...config };
        this.pivotDetector = new PivotDetector(
            this.config.pivotLeftBars,
            this.config.pivotRightBars
        );
    }
}

// ATR (Average True Range) Indicator
// Used for trailing stop distance calculation

import { Decimal } from 'decimal.js';
import { Candle } from '../types/index.js';

export interface ATRValue {
    atr: Decimal;
    trueRange: Decimal;
    timestamp: number;
}

export class ATRCalculator {
    private readonly period: number;
    private history: ATRValue[] = [];
    private prevClose: Decimal | null = null;

    /**
     * @param period ATR smoothing period (default 14)
     */
    constructor(period: number = 14) {
        this.period = period;
    }

    /**
     * Calculate True Range for a single candle
     * TR = max(high - low, |high - prevClose|, |low - prevClose|)
     */
    private calculateTrueRange(candle: Candle, prevClose: Decimal | null): Decimal {
        const highLow = candle.high.sub(candle.low);

        if (!prevClose) {
            return highLow;
        }

        const highClose = candle.high.sub(prevClose).abs();
        const lowClose = candle.low.sub(prevClose).abs();

        return Decimal.max(highLow, highClose, lowClose);
    }

    /**
     * Update ATR with new candle data
     * Returns current ATR value or null if insufficient data
     */
    public update(candles: Candle[]): ATRValue | null {
        if (candles.length < 2) {
            return null;
        }

        // Calculate True Range for all candles
        const trueRanges: Decimal[] = [];
        for (let i = 0; i < candles.length; i++) {
            const prevClose = i > 0 ? candles[i - 1].close : null;
            trueRanges.push(this.calculateTrueRange(candles[i], prevClose));
        }

        // Need at least 'period' candles for ATR
        if (trueRanges.length < this.period) {
            return null;
        }

        // Calculate ATR using Wilder's smoothing method (EMA-like)
        // First ATR is simple average of first 'period' true ranges
        let atr: Decimal;

        if (this.history.length === 0) {
            // Initial ATR: SMA of first 'period' true ranges
            const initialSlice = trueRanges.slice(0, this.period);
            atr = initialSlice.reduce((sum, tr) => sum.add(tr), new Decimal(0)).div(this.period);
        } else {
            // Subsequent ATRs: Wilder smoothing
            // ATR = ((prevATR * (period - 1)) + currentTR) / period
            const prevATR = this.history[this.history.length - 1].atr;
            const currentTR = trueRanges[trueRanges.length - 1];
            atr = prevATR.mul(this.period - 1).add(currentTR).div(this.period);
        }

        const latestCandle = candles[candles.length - 1];
        const result: ATRValue = {
            atr,
            trueRange: trueRanges[trueRanges.length - 1],
            timestamp: latestCandle.timestamp
        };

        // Store in history (keep last 100 values)
        this.history.push(result);
        if (this.history.length > 100) {
            this.history.shift();
        }

        this.prevClose = latestCandle.close;

        return result;
    }

    /**
     * Get current ATR value without updating
     */
    public getCurrentATR(): Decimal | null {
        if (this.history.length === 0) {
            return null;
        }
        return this.history[this.history.length - 1].atr;
    }

    /**
     * Get ATR history
     */
    public getHistory(): ATRValue[] {
        return [...this.history];
    }

    /**
     * Reset calculator state
     */
    public reset(): void {
        this.history = [];
        this.prevClose = null;
    }

    /**
     * Get the configured period
     */
    public getPeriod(): number {
        return this.period;
    }
}

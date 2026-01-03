import { Decimal } from 'decimal.js';
import { Candle } from '../types/index.js';
import { FinancialMath } from '../utils/math.js';

export interface Pivot {
    timestamp: number;
    price: Decimal;
    type: 'high' | 'low';
    index: number; // Index in the candle array
}

export class PivotDetector {
    private leftBars: number;
    private rightBars: number;

    constructor(leftBars: number = 5, rightBars: number = 2) {
        this.leftBars = leftBars;
        this.rightBars = rightBars;
    }

    /**
     * Detect pivots in a candle array.
     * A pivot is confirmed only if there are enough bars to the right.
     */
    public detect(candles: Candle[]): Pivot[] {
        const pivots: Pivot[] = [];
        if (candles.length < this.leftBars + this.rightBars + 1) {
            return pivots;
        }

        // Iterate up to length - rightBars (confirmation bridge)
        for (let i = this.leftBars; i < candles.length - this.rightBars; i++) {
            const current = candles[i];
            let isPivotHigh = true;
            let isPivotLow = true;

            // Check left
            for (let j = 1; j <= this.leftBars; j++) {
                if (FinancialMath.lessThanOrEqual(candles[i].high, candles[i - j].high)) isPivotHigh = false;
                if (FinancialMath.greaterThanOrEqual(candles[i].low, candles[i - j].low)) isPivotLow = false;
            }

            // Check right
            for (let j = 1; j <= this.rightBars; j++) {
                if (FinancialMath.lessThanOrEqual(candles[i].high, candles[i + j].high)) isPivotHigh = false;
                if (FinancialMath.greaterThanOrEqual(candles[i].low, candles[i + j].low)) isPivotLow = false;
            }

            if (isPivotHigh) {
                pivots.push({
                    timestamp: current.timestamp,
                    price: current.high,
                    type: 'high',
                    index: i
                });
            }
            if (isPivotLow) {
                pivots.push({
                    timestamp: current.timestamp,
                    price: current.low,
                    type: 'low',
                    index: i
                });
            }
        }

        return pivots;
    }
}
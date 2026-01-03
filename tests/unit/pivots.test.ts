import { describe, it, expect } from 'vitest';
import { PivotDetector } from '../../src/indicators/pivots.js';
import { Candle } from '../../src/types/index.js';
import { Decimal } from 'decimal.js';

describe('PivotDetector', () => {
    const createCandle = (low: number, high: number, timestamp: number): Candle => ({
        timestamp,
        open: new Decimal(0),
        high: new Decimal(high),
        low: new Decimal(low),
        close: new Decimal(0),
        volume: new Decimal(0)
    });

    it('should detect a pivot high with confirmation', () => {
        const detector = new PivotDetector(2, 2);
        const candles = [
            createCandle(10, 20, 1),
            createCandle(10, 21, 2),
            createCandle(10, 25, 3), // Pivot High
            createCandle(10, 22, 4),
            createCandle(10, 21, 5)
        ];

        const pivots = detector.detect(candles);
        expect(pivots).toHaveLength(1);
        expect(pivots[0].type).toBe('high');
        expect(pivots[0].price.toNumber()).toBe(25);
    });

    it('should not detect a pivot if confirmation bars are missing', () => {
        const detector = new PivotDetector(2, 2);
        const candles = [
            createCandle(10, 20, 1),
            createCandle(10, 21, 2),
            createCandle(10, 25, 3),
            createCandle(10, 22, 4) // Only 1 bar to the right, needs 2
        ];

        const pivots = detector.detect(candles);
        expect(pivots).toHaveLength(0);
    });
});

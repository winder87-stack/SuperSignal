// Stochastic Oscillator Implementation
// Formula: %K = 100 * (Close - LowestLow) / (HighestHigh - LowestLow)
// %D = SMA of %K over D period

import { Decimal } from 'decimal.js';
import { FinancialMath } from '../utils/math';
import { Candle, StochasticValue, StochasticConfig } from '../types';

export class StochasticOscillator {
  private kPeriod: number;
  private dPeriod: number;
  private name: string;

  constructor(config: StochasticConfig) {
    this.kPeriod = config.kPeriod;
    this.dPeriod = config.dPeriod;
    this.name = config.name;
  }

  /**
   * Calculate stochastic %K value for a given period
   * %K = 100 * (Close - LowestLow) / (HighestHigh - LowestLow)
   */
  private calculateK(candles: Candle[]): Decimal | null {
    if (candles.length < this.kPeriod) {
      return null;
    }

    // Get the last K candles
    const periodCandles = candles.slice(-this.kPeriod);

    // Find highest high and lowest low in the period
    const highestHigh = periodCandles.reduce((max, candle) =>
      FinancialMath.greaterThan(candle.high, max) ? candle.high : max,
      periodCandles[0].high
    );

    const lowestLow = periodCandles.reduce((min, candle) =>
      FinancialMath.lessThan(candle.low, min) ? candle.low : min,
      periodCandles[0].low
    );

    // Get current close price
    const currentClose = candles[candles.length - 1].close;

    // Calculate %K
    const denominator = FinancialMath.subtract(highestHigh, lowestLow);

    if (denominator.isZero()) {
      // If no price movement, return 50 (neutral)
      return new Decimal(50);
    }

    const numerator = FinancialMath.subtract(currentClose, lowestLow);
    const kValue = FinancialMath.multiply(
      FinancialMath.divide(numerator, denominator),
      100
    );

    // Clamp between 0 and 100
    return FinancialMath.clamp(kValue, 0, 100);
  }

  /**
   * Calculate stochastic %D value (SMA of %K)
   */
  private calculateD(kValues: Decimal[]): Decimal | null {
    if (kValues.length < this.dPeriod) {
      return null;
    }

    // Get the last D %K values
    const periodValues = kValues.slice(-this.dPeriod);

    // Calculate simple moving average
    const sum = periodValues.reduce((acc, value) =>
      FinancialMath.add(acc, value),
      new Decimal(0)
    );

    return FinancialMath.divide(sum, this.dPeriod);
  }

  /**
   * Calculate stochastic value for current candles
   */
  public calculate(candles: Candle[]): StochasticValue | null {
    if (candles.length < this.kPeriod) {
      return null;
    }

    const kValue = this.calculateK(candles);
    if (!kValue) {
      return null;
    }

    // For %D, we need historical %K values
    // In a real implementation, we'd maintain a buffer of previous %K values
    // For now, we'll approximate %D as current %K (this is common for the first calculation)
    const dValue = kValue; // TODO: Implement proper %D calculation with historical buffer

    return {
      k: kValue,
      d: dValue,
      timestamp: candles[candles.length - 1].timestamp
    };
  }

  /**
   * Check if stochastic is in oversold territory (< 20)
   */
  public isOversold(value: StochasticValue): boolean {
    return FinancialMath.lessThan(value.k, 20);
  }

  /**
   * Check if stochastic is in overbought territory (> 80)
   */
  public isOverbought(value: StochasticValue): boolean {
    return FinancialMath.greaterThan(value.k, 80);
  }

  /**
   * Check if stochastic is in extreme oversold (< 10)
   */
  public isExtremeOversold(value: StochasticValue): boolean {
    return FinancialMath.lessThan(value.k, 10);
  }

  /**
   * Check if stochastic is in extreme overbought (> 90)
   */
  public isExtremeOverbought(value: StochasticValue): boolean {
    return FinancialMath.greaterThan(value.k, 90);
  }

  /**
   * Check if %K is curling up (increasing)
   */
  public isCurlingUp(current: StochasticValue, previous: StochasticValue | null): boolean {
    if (!previous) return false;
    return FinancialMath.greaterThan(current.k, previous.k);
  }

  /**
   * Check if %K is curling down (decreasing)
   */
  public isCurlingDown(current: StochasticValue, previous: StochasticValue | null): boolean {
    if (!previous) return false;
    return FinancialMath.lessThan(current.k, previous.k);
  }

  public getName(): string {
    return this.name;
  }

  public getConfig(): StochasticConfig {
    return {
      kPeriod: this.kPeriod,
      dPeriod: this.dPeriod,
      name: this.name
    };
  }
}

// Factory function to create stochastic oscillators
export class StochasticFactory {
  static createFast(): StochasticOscillator {
    return new StochasticOscillator({
      kPeriod: 9,
      dPeriod: 3,
      name: 'Fast'
    });
  }

  static createMedium(): StochasticOscillator {
    return new StochasticOscillator({
      kPeriod: 14,
      dPeriod: 3,
      name: 'Medium'
    });
  }

  static createSlow(): StochasticOscillator {
    return new StochasticOscillator({
      kPeriod: 40,
      dPeriod: 4,
      name: 'Slow'
    });
  }

  static createTrend(): StochasticOscillator {
    return new StochasticOscillator({
      kPeriod: 60,
      dPeriod: 10,
      name: 'Trend'
    });
  }
}

// Stochastic Manager to handle all 4 oscillators
export class StochasticManager {
  private fast: StochasticOscillator;
  private medium: StochasticOscillator;
  private slow: StochasticOscillator;
  private trend: StochasticOscillator;

  // Historical buffers for proper %D calculation
  private fastKHistory: Decimal[] = [];
  private mediumKHistory: Decimal[] = [];
  private slowKHistory: Decimal[] = [];
  private trendKHistory: Decimal[] = [];

  constructor() {
    this.fast = StochasticFactory.createFast();
    this.medium = StochasticFactory.createMedium();
    this.slow = StochasticFactory.createSlow();
    this.trend = StochasticFactory.createTrend();
  }

  /**
   * Update all stochastic indicators with new candle data
   */
  public update(candles: Candle[]): {
    fast: StochasticValue | null;
    medium: StochasticValue | null;
    slow: StochasticValue | null;
    trend: StochasticValue | null;
  } {
    const fastValue = this.fast.calculate(candles);
    const mediumValue = this.medium.calculate(candles);
    const slowValue = this.slow.calculate(candles);
    const trendValue = this.trend.calculate(candles);

    // Update historical buffers for %D calculation
    if (fastValue) {
      this.fastKHistory.push(fastValue.k);
      // Keep only last 10 values for %D calculation
      if (this.fastKHistory.length > 10) {
        this.fastKHistory.shift();
      }
    }

    if (mediumValue) {
      this.mediumKHistory.push(mediumValue.k);
      if (this.mediumKHistory.length > 10) {
        this.mediumKHistory.shift();
      }
    }

    if (slowValue) {
      this.slowKHistory.push(slowValue.k);
      if (this.slowKHistory.length > 10) {
        this.slowKHistory.shift();
      }
    }

    if (trendValue) {
      this.trendKHistory.push(trendValue.k);
      if (this.trendKHistory.length > 10) {
        this.trendKHistory.shift();
      }
    }

    // Recalculate %D values with proper historical data
    if (fastValue && this.fastKHistory.length >= 3) {
      const dValues = this.fastKHistory.slice(-3);
      const sum = dValues.reduce((acc, val) => FinancialMath.add(acc, val), new Decimal(0));
      fastValue.d = FinancialMath.divide(sum, 3);
    }

    if (mediumValue && this.mediumKHistory.length >= 3) {
      const dValues = this.mediumKHistory.slice(-3);
      const sum = dValues.reduce((acc, val) => FinancialMath.add(acc, val), new Decimal(0));
      mediumValue.d = FinancialMath.divide(sum, 3);
    }

    if (slowValue && this.slowKHistory.length >= 4) {
      const dValues = this.slowKHistory.slice(-4);
      const sum = dValues.reduce((acc, val) => FinancialMath.add(acc, val), new Decimal(0));
      slowValue.d = FinancialMath.divide(sum, 4);
    }

    if (trendValue && this.trendKHistory.length >= 10) {
      const dValues = this.trendKHistory.slice(-10);
      const sum = dValues.reduce((acc, val) => FinancialMath.add(acc, val), new Decimal(0));
      trendValue.d = FinancialMath.divide(sum, 10);
    }

    return {
      fast: fastValue,
      medium: mediumValue,
      slow: slowValue,
      trend: trendValue
    };
  }

  /**
   * Check if all 4 stochastics are in extreme zones (Quad Extreme)
   */
  public isQuadExtreme(
    values: {
      fast: StochasticValue;
      medium: StochasticValue;
      slow: StochasticValue;
      trend: StochasticValue;
    },
    direction: 'oversold' | 'overbought'
  ): boolean {
    const { fast, medium, slow, trend } = values;

    if (direction === 'oversold') {
      return (
        this.fast.isExtremeOversold(fast) &&
        this.medium.isExtremeOversold(medium) &&
        this.slow.isExtremeOversold(slow) &&
        this.trend.isExtremeOversold(trend)
      );
    } else {
      return (
        this.fast.isExtremeOverbought(fast) &&
        this.medium.isExtremeOverbought(medium) &&
        this.slow.isExtremeOverbought(slow) &&
        this.trend.isExtremeOverbought(trend)
      );
    }
  }

  /**
   * Get stochastic oscillators for external access
   */
  public getOscillators(): {
    fast: StochasticOscillator;
    medium: StochasticOscillator;
    slow: StochasticOscillator;
    trend: StochasticOscillator;
  } {
    return {
      fast: this.fast,
      medium: this.medium,
      slow: this.slow,
      trend: this.trend
    };
  }
}
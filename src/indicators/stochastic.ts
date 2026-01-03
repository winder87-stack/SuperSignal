import { Decimal } from 'decimal.js';
import { FinancialMath } from '../utils/math.js';
import { Candle, StochasticValue, StochasticConfig } from '../types/index.js';

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
   * Uses internal state or provided context for %D SMA.
   */
  public calculate(candles: Candle[], kHistory: Decimal[]): StochasticValue | null {
    if (candles.length < this.kPeriod) {
      return null;
    }

    const kValue = this.calculateK(candles);
    if (!kValue) {
      return null;
    }

    // %D is the SMA of %K values
    let dValue = kValue;
    if (kHistory.length >= this.dPeriod) {
      const dSum = kHistory.slice(-this.dPeriod).reduce((acc, val) => FinancialMath.add(acc, val), new Decimal(0));
      dValue = FinancialMath.divide(dSum, this.dPeriod);
    }

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

  // Historical buffers for Strategy (Divergence/Rotation)
  // Store last 100 candles worth of values
  private fastHistory: StochasticValue[] = [];
  private mediumHistory: StochasticValue[] = [];
  private slowHistory: StochasticValue[] = [];
  private trendHistory: StochasticValue[] = [];
  private readonly MAX_HISTORY = 100;

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
    // We calculate %K first to update the history for %D SMA
    const fastK = this.fast['calculateK'](candles);
    const mediumK = this.medium['calculateK'](candles);
    const slowK = this.slow['calculateK'](candles);
    const trendK = this.trend['calculateK'](candles);

    if (fastK) {
      this.fastKHistory.push(fastK);
      if (this.fastKHistory.length > this.MAX_HISTORY) this.fastKHistory.shift();
    }
    if (mediumK) {
      this.mediumKHistory.push(mediumK);
      if (this.mediumKHistory.length > this.MAX_HISTORY) this.mediumKHistory.shift();
    }
    if (slowK) {
      this.slowKHistory.push(slowK);
      if (this.slowKHistory.length > this.MAX_HISTORY) this.slowKHistory.shift();
    }
    if (trendK) {
      this.trendKHistory.push(trendK);
      if (this.trendKHistory.length > this.MAX_HISTORY) this.trendKHistory.shift();
    }

    const fastValue = this.fast.calculate(candles, this.fastKHistory);
    const mediumValue = this.medium.calculate(candles, this.mediumKHistory);
    const slowValue = this.slow.calculate(candles, this.slowKHistory);
    const trendValue = this.trend.calculate(candles, this.trendKHistory);



    // Store completed values in history
    if (fastValue) {
      this.fastHistory.push(fastValue);
      if (this.fastHistory.length > this.MAX_HISTORY) this.fastHistory.shift();
    }
    if (mediumValue) {
      this.mediumHistory.push(mediumValue);
      if (this.mediumHistory.length > this.MAX_HISTORY) this.mediumHistory.shift();
    }
    if (slowValue) {
      this.slowHistory.push(slowValue);
      if (this.slowHistory.length > this.MAX_HISTORY) this.slowHistory.shift();
    }
    if (trendValue) {
      this.trendHistory.push(trendValue);
      if (this.trendHistory.length > this.MAX_HISTORY) this.trendHistory.shift();
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

  /**
   * Get historical values for a specific stochastic type
   */
  public getHistory(type: 'fast' | 'medium' | 'slow' | 'trend'): StochasticValue[] {
    switch (type) {
      case 'fast': return this.fastHistory;
      case 'medium': return this.mediumHistory;
      case 'slow': return this.slowHistory;
      case 'trend': return this.trendHistory;
    }
  }
}
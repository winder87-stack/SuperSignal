// Super Signal Strategy Implementation
// Entry = Quad Extreme + Divergence + Location + Rotation

import { Decimal } from 'decimal.js';
import { FinancialMath } from '../utils/math';
import { TradingLogger } from '../utils/logger';
import {
  Candle,
  TradingSignal,
  SignalDirection,
  SignalComponents,
  StochasticIndicators,
  TradingPair
} from '../types';

export interface DivergenceSignal {
  type: 'bullish' | 'bearish';
  strength: number; // 0-1
  pricePoint: Decimal;
  stochasticPoint: Decimal;
}

export interface SupportResistanceLevel {
  type: 'support' | 'resistance';
  price: Decimal;
  strength: number; // 0-1
  touches: number;
}

export class SuperSignalStrategy {
  private divergenceHistory: Map<TradingPair, DivergenceSignal[]> = new Map();
  private supportResistanceHistory: Map<TradingPair, SupportResistanceLevel[]> = new Map();

  /**
   * Main signal generation method
   * Entry = Quad Extreme + Divergence + Location + Rotation
   */
  public generateSignal(
    pair: TradingPair,
    candles: Candle[],
    stochastics: StochasticIndicators
  ): TradingSignal | null {
    try {
      // Check all signal components
      const components: SignalComponents = {
        quadExtreme: this.checkQuadExtreme(stochastics),
        divergence: this.detectDivergence(candles, stochastics),
        location: this.checkLocation(candles),
        rotation: this.checkRotation(stochastics)
      };

      // Generate signal based on components
      const signal = this.combineSignals(pair, components, candles[candles.length - 1]);

      if (signal) {
        TradingLogger.logSignal(signal);
      }

      return signal;

    } catch (error) {
      TradingLogger.logError(error as Error, `Signal generation for ${pair}`);
      return null;
    }
  }

  /**
   * Check Quad Extreme: All 4 stochastics in extreme zones
   */
  private checkQuadExtreme(stochastics: StochasticIndicators): boolean {
    const { fast, medium, slow, trend } = stochastics;

    // Check if all are in extreme oversold (<10) or extreme overbought (>90)
    const allExtremeOversold = FinancialMath.lessThan(fast.k, 10) &&
                              FinancialMath.lessThan(medium.k, 10) &&
                              FinancialMath.lessThan(slow.k, 10) &&
                              FinancialMath.lessThan(trend.k, 10);

    const allExtremeOverbought = FinancialMath.greaterThan(fast.k, 90) &&
                                FinancialMath.greaterThan(medium.k, 90) &&
                                FinancialMath.greaterThan(slow.k, 90) &&
                                FinancialMath.greaterThan(trend.k, 90);

    return allExtremeOversold || allExtremeOverbought;
  }

  /**
   * Detect divergence between price and stochastic
   */
  private detectDivergence(
    _candles: Candle[],
    _stochastics: StochasticIndicators
  ): 'bullish' | 'bearish' | null {
    // TODO: Implement sophisticated divergence detection
    // Bullish divergence: Price makes lower low, stochastic makes higher low
    // Bearish divergence: Price makes higher high, stochastic makes lower high
    // This requires historical data comparison

    // For now, return null (divergence detection is complex and requires historical data)
    return null;
  }

  /**
   * Check location: Support or Resistance levels
   */
  private checkLocation(candles: Candle[]): 'support' | 'resistance' | null {
    if (candles.length < 10) return null;

    const currentPrice = candles[candles.length - 1].close;
    const recentSlice = candles.slice(-20);

    // Simple support/resistance detection based on recent highs/lows
    const recentHigh = recentSlice.reduce((max, c) =>
      FinancialMath.greaterThan(c.high, max) ? c.high : max, recentSlice[0].high
    );

    const recentLow = recentSlice.reduce((min, c) =>
      FinancialMath.lessThan(c.low, min) ? c.low : min, recentSlice[0].low
    );

    // Check if current price is near support or resistance
    const nearSupport = FinancialMath.percentageChange(recentLow, currentPrice).abs().toNumber() < 1;
    const nearResistance = FinancialMath.percentageChange(recentHigh, currentPrice).abs().toNumber() < 1;

    if (nearSupport) return 'support';
    if (nearResistance) return 'resistance';

    return null;
  }

  /**
   * Check rotation: Fast stochastic curling direction
   */
  private checkRotation(_stochastics: StochasticIndicators): 'up' | 'down' | null {
    // This would need historical stochastic data to detect curling
    // For now, return null - would be implemented with historical buffer
    return null;
  }

  /**
   * Combine all signal components to generate final signal
   */
  private combineSignals(
    pair: TradingPair,
    components: SignalComponents,
    currentCandle: Candle
  ): TradingSignal | null {
    // Extract components for cleaner logic
    const { quadExtreme, divergence, location, rotation } = components;

    // Long Signal: OS (<20) + Bullish Div + Support + Fast curling up
    const longSignal = quadExtreme &&
                      divergence === 'bullish' &&
                      location === 'support' &&
                      rotation === 'up';

    // Short Signal: OB (>80) + Bearish Div + Resistance + Fast curling down
    const shortSignal = quadExtreme &&
                       divergence === 'bearish' &&
                       location === 'resistance' &&
                       rotation === 'down';

    if (!longSignal && !shortSignal) {
      return null;
    }

    // Calculate signal strength (0-1)
    let strength = 0;
    if (quadExtreme) strength += 0.4;
    if (divergence) strength += 0.3;
    if (location) strength += 0.2;
    if (rotation) strength += 0.1;

    const direction: SignalDirection = longSignal ? 'long' : 'short';

    return {
      pair,
      direction,
      strength,
      components,
      timestamp: Date.now(),
      price: currentCandle.close
    };
  }

  /**
   * Check if position should be closed based on exit conditions
   * Longs: Fast stoch reaches ~80
   * Shorts: Fast stoch reaches ~20
   */
  public shouldExit(
    position: { direction: SignalDirection; pair: TradingPair },
    stochastics: StochasticIndicators
  ): boolean {
    const fastK = stochastics.fast.k.toNumber();
    const fastK = stochastics.fast.k.toNumber();

    if (position.direction === 'long') {
      // Exit long when fast stochastic reaches ~80
      return fastK >= 75; // Slightly below 80 for buffer
    } else {
      // Exit short when fast stochastic reaches ~20
      return fastK <= 25; // Slightly above 20 for buffer
    }
  }

  /**
   * Get signal statistics for monitoring
   */
  public getSignalStats(pair: TradingPair): {
    totalSignals: number;
    longSignals: number;
    shortSignals: number;
    avgStrength: number;
  } {
    // This would track historical signals - for now return placeholder
    return {
      totalSignals: 0,
      longSignals: 0,
      shortSignals: 0,
      avgStrength: 0
    };
  }

  /**
   * Advanced divergence detection (placeholder for future implementation)
   */
  /**
   * Advanced divergence detection (placeholder for future implementation)
   */
  private detectBullishDivergence(_candles: Candle[], _stochastics: StochasticIndicators): DivergenceSignal | null {
    // Complex divergence detection algorithm would go here
    // This requires analyzing price swings vs stochastic swings over time
    return null;
  }

  /**
   * Advanced support/resistance detection (placeholder for future implementation)
   */
  private detectSupportResistance(_candles: Candle[]): SupportResistanceLevel[] {
    // Advanced S/R detection using pivot points, trendlines, etc.
    return [];
  }
}

// Signal Processor class to handle multiple pairs
export class SignalProcessor {
  private strategies: Map<TradingPair, SuperSignalStrategy> = new Map();

  constructor(pairs: TradingPair[]) {
    pairs.forEach(pair => {
      this.strategies.set(pair, new SuperSignalStrategy());
    });
  }

  /**
   * Process signals for all pairs
   */
  public processSignals(
    marketData: Map<TradingPair, { candles: Candle[]; stochastics: StochasticIndicators }>
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];

    for (const [pair, data] of marketData) {
      const strategy = this.strategies.get(pair);
      if (strategy) {
        const signal = strategy.generateSignal(pair, data.candles, data.stochastics);
        if (signal) {
          signals.push(signal);
        }
      }
    }

    return signals;
  }

  /**
   * Check exit conditions for open positions
   */
  public checkExits(
    positions: Array<{ direction: SignalDirection; pair: TradingPair; stochastics: StochasticIndicators }>
  ): TradingPair[] {
    const pairsToExit: TradingPair[] = [];

    positions.forEach(({ pair, direction, stochastics }) => {
      const strategy = this.strategies.get(pair);
      if (strategy && strategy.shouldExit({ direction, pair }, stochastics)) {
        pairsToExit.push(pair);
      }
    });

    return pairsToExit;
  }

  /**
   * Get strategy instance for a pair
   */
  public getStrategy(pair: TradingPair): SuperSignalStrategy | undefined {
    return this.strategies.get(pair);
  }
}
// Super Signal Strategy Implementation
// Entry = Quad Extreme + Divergence + Location + Rotation

import { Decimal } from 'decimal.js';
import { FinancialMath } from '../utils/math.js';
import { TradingLogger } from '../utils/logger.js';
import {
  Candle,
  TradingSignal,
  SignalDirection,
  SignalComponents,
  StochasticIndicators,
  TradingPair
} from '../types/index.js';
import { StochasticManager } from '../indicators/stochastic.js';
import { DivergenceDetector, DivergenceSignal } from '../indicators/divergence.js';

export interface SupportResistanceLevel {
  type: 'support' | 'resistance';
  price: Decimal;
  strength: Decimal; // 0-1
  touches: number;
}

export class SuperSignalStrategy {
  private divergenceHistory: Map<TradingPair, DivergenceSignal[]> = new Map();
  private supportResistanceHistory: Map<TradingPair, SupportResistanceLevel[]> = new Map();
  private divergenceDetector: DivergenceDetector;

  constructor() {
    // Initialize divergence detector with default config (5 bars left, 2 bars right)
    this.divergenceDetector = new DivergenceDetector();
  }

  /**
   * Main signal generation method
   * Entry = Quad Extreme + Divergence + Location + Rotation
   */
  public generateSignal(
    pair: TradingPair,
    candles: Candle[],
    stochasticManager: StochasticManager
  ): TradingSignal | null {
    try {
      // Update stochastics and get current values
      const currentValues = stochasticManager.update(candles);

      if (!currentValues.fast || !currentValues.medium || !currentValues.slow || !currentValues.trend) {
        return null;
      }

      const stochIndicators = currentValues as StochasticIndicators;

      // Check all signal components
      const components: SignalComponents = {
        quadExtreme: this.checkQuadExtreme(stochIndicators),
        divergence: this.divergenceDetector.detect(candles, stochasticManager.getHistory('fast')),
        location: this.checkLocation(candles),
        rotation: this.checkRotation(stochasticManager)
      };

      // Generate signal based on components
      const signal = this.combineSignals(pair, components, candles[candles.length - 1], stochasticManager);

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

    // Check if all are in extreme oversold (<20)
    const allExtremeOversold = FinancialMath.lessThan(fast.k, 20) &&
      FinancialMath.lessThan(medium.k, 20) &&
      FinancialMath.lessThan(slow.k, 20) &&
      FinancialMath.lessThan(trend.k, 20);

    // Check if all are in extreme overbought (>80)
    const allExtremeOverbought = FinancialMath.greaterThan(fast.k, 80) &&
      FinancialMath.greaterThan(medium.k, 80) &&
      FinancialMath.greaterThan(slow.k, 80) &&
      FinancialMath.greaterThan(trend.k, 80);

    return allExtremeOversold || allExtremeOverbought;
  }



  /**
   * Check location: Support or Resistance levels
   */
  private checkLocation(candles: Candle[]): 'support' | 'resistance' | null {
    if (candles.length < 20) return null;

    const currentPrice = candles[candles.length - 1].close;
    const recentSlice = candles.slice(-20); // Look back 20 periods

    // Identify local min/max in recent memory
    const recentLow = recentSlice.reduce((min, c) =>
      FinancialMath.lessThan(c.low, min) ? c.low : min, recentSlice[0].low
    );

    // If we are within 0.5% of the recent low
    if (FinancialMath.percentageChange(recentLow, currentPrice).abs().toNumber() < 0.5) {
      return 'support';
    }

    const recentHigh = recentSlice.reduce((max, c) =>
      FinancialMath.greaterThan(c.high, max) ? c.high : max, recentSlice[0].high
    );

    if (FinancialMath.percentageChange(recentHigh, currentPrice).abs().toNumber() < 0.5) {
      return 'resistance';
    }

    return null;
  }

  /**
   * Check rotation: 9-3 Fast Stochastic K crosses D and moves away from extreme.
   */
  private checkRotation(manager: StochasticManager): 'up' | 'down' | null {
    const fastHistory = manager.getHistory('fast');
    if (fastHistory.length < 2) return null;

    const current = fastHistory[fastHistory.length - 1];
    const previous = fastHistory[fastHistory.length - 2];

    // Rotation Up: K crosses above D (or was above and moving up)
    // Rule: Rotation: 9–3 turns first (K crosses D and moves away from extreme)
    if (FinancialMath.greaterThan(current.k, current.d) && FinancialMath.lessThanOrEqual(previous.k, previous.d)) {
      return 'up';
    }

    // Rotation Down: K crosses below D
    if (FinancialMath.lessThan(current.k, current.d) && FinancialMath.greaterThanOrEqual(previous.k, previous.d)) {
      return 'down';
    }

    return null;
  }

  /**
   * Combine all signal components to generate final signal
   */
  private combineSignals(
    pair: TradingPair,
    components: SignalComponents,
    currentCandle: Candle,
    manager: StochasticManager
  ): TradingSignal | null {
    const { quadExtreme, divergence, location, rotation } = components;

    // Filter: Embedded Slow Stochastic pinned >90 or <10 reduces reversal probability.
    const trendHistory = manager.getHistory('trend');
    if (trendHistory.length > 0) {
      const lastTrend = trendHistory[trendHistory.length - 1];
      if (FinancialMath.greaterThan(lastTrend.k, 90) || FinancialMath.lessThan(lastTrend.k, 10)) {
        // Embedded! Requires Location confirmation for reversal.
        if (!location) return null;
      }
    }

    // "Entry mode: rotation-only" (Rule 9)
    if (!rotation) return null;

    // Long Signal
    const isLong = divergence === 'bullish' && rotation === 'up';

    // Short Signal
    const isShort = divergence === 'bearish' && rotation === 'down';

    if (!isLong && !isShort) {
      return null;
    }

    // Strength calculation using Decimal
    let strength = FinancialMath.decimal(0.5);
    if (quadExtreme) strength = strength.add(0.2);
    if (location) strength = strength.add(0.2);
    if (divergence) strength = strength.add(0.1);

    // Stop Loss calculation (Rule 4: Stops beyond divergence extreme + buffer)
    let stopLoss: Decimal | undefined;
    const buffer = currentCandle.close.mul(0.001); // 0.1% buffer
    if (isLong) {
      stopLoss = currentCandle.low.sub(buffer);
    } else {
      stopLoss = currentCandle.high.add(buffer);
    }

    return {
      pair,
      direction: isLong ? 'long' : 'short',
      strength: FinancialMath.clamp(strength, 0, 1),
      components,
      timestamp: Date.now(),
      price: currentCandle.close,
      stopLoss,
      type: 'entry'
    };
  }

  /**
   * Check if position should be closed based on exit conditions
   */
  public shouldExit(
    position: { direction: SignalDirection; pair: TradingPair },
    stochastics: StochasticManager
  ): boolean {
    const history = stochastics.getHistory('fast');
    if (history.length === 0) return false;

    const fast = history[history.length - 1];

    // Exit: fast K hits 80/20 (Rule 9)
    if (position.direction === 'long') {
      return FinancialMath.greaterThanOrEqual(fast.k, 80);
    } else {
      return FinancialMath.lessThanOrEqual(fast.k, 20);
    }
  }

  public getSignalStats(pair: TradingPair): any {
    return {};
  }
}

// Signal Processor class to handle multiple pairs
export class SignalProcessor {
  private strategies: Map<TradingPair, SuperSignalStrategy> = new Map();
  // Manage One StochasticManager per Pair
  private managers: Map<TradingPair, StochasticManager> = new Map();
  // Rolling candle buffer per pair (up to 100 candles)
  private candleBuffers: Map<TradingPair, Candle[]> = new Map();
  private readonly MAX_CANDLES = 100;

  constructor(pairs: TradingPair[]) {
    pairs.forEach(pair => {
      this.strategies.set(pair, new SuperSignalStrategy());
      this.managers.set(pair, new StochasticManager());
      this.candleBuffers.set(pair, []);
    });
  }

  /**
   * Process a single candle update from WebSocket
   * Returns a signal if one is generated
   */
  public processCandle(pair: TradingPair, candle: Candle): TradingSignal | null {
    const buffer = this.candleBuffers.get(pair);
    const strategy = this.strategies.get(pair);
    const manager = this.managers.get(pair);

    if (!buffer || !strategy || !manager) {
      TradingLogger.warn(`Unknown pair: ${pair}`);
      return null;
    }

    // Check if this is an update to the current candle or a new one
    if (buffer.length > 0) {
      const lastCandle = buffer[buffer.length - 1];
      if (lastCandle.timestamp === candle.timestamp) {
        // Update existing candle (intrabar update)
        buffer[buffer.length - 1] = candle;
      } else {
        // New candle
        buffer.push(candle);
        if (buffer.length > this.MAX_CANDLES) {
          buffer.shift();
        }
      }
    } else {
      buffer.push(candle);
    }

    // Need minimum candles for strategy
    if (buffer.length < 60) {
      return null;
    }

    // Generate signal
    return strategy.generateSignal(pair, buffer, manager);
  }

  /**
   * Get current candle count for a pair
   */
  public getCandleCount(pair: TradingPair): number {
    return this.candleBuffers.get(pair)?.length ?? 0;
  }

  /**
   * Process signals for all pairs
   * Pass marketData with candles. Stochastics are calculated internally.
   */
  public processSignals(
    marketData: Map<TradingPair, { candles: Candle[] }>
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];

    for (const [pair, data] of marketData) {
      const manager = this.managers.get(pair);
      const strategy = this.strategies.get(pair);

      if (strategy && manager) {
        const signal = strategy.generateSignal(pair, data.candles, manager);
        if (signal) {
          signals.push(signal);
        }
      }
    }

    return signals;
  }

  public checkExits(
    positions: Array<{ direction: SignalDirection; pair: TradingPair }>
  ): TradingPair[] {
    const pairsToExit: TradingPair[] = [];

    positions.forEach(({ pair, direction }) => {
      const strategy = this.strategies.get(pair);
      const manager = this.managers.get(pair);

      if (strategy && manager && strategy.shouldExit({ direction, pair }, manager)) {
        pairsToExit.push(pair);
      }
    });

    return pairsToExit;
  }

  public getStrategy(pair: TradingPair): SuperSignalStrategy | undefined {
    return this.strategies.get(pair);
  }
}
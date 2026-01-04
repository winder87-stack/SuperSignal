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
  TradingPair,
  StrategyConfig,
} from '../types/index.js';
import { StochasticManager } from '../indicators/stochastic.js';
import { DivergenceDetector, DivergenceSignal, DivergenceResult } from '../indicators/divergence.js';

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
  private config: StrategyConfig;

  // Track consecutive bars where Trend K is embedded (>90 or <10) per trading pair
  private embeddedStreaks: Map<TradingPair, { high: number, low: number }> = new Map();
  private readonly EMBEDDED_STREAK_THRESHOLD = 3; // Bars to trigger hard block

  // For relaxed mode: store last stochastic values for directional filtering
  private lastStochastics: StochasticIndicators | null = null;

  constructor(config?: Partial<StrategyConfig>) {
    // Initialize divergence detector with default config (5 bars left, 2 bars right)
    this.divergenceDetector = new DivergenceDetector();
    // Default to 'strict' mode (high-conviction quad extreme approach)
    this.config = {
      entryMode: config?.entryMode ?? 'strict'
    };
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

      // Store for directional filtering in relaxed mode
      this.lastStochastics = stochIndicators;

      // Get detailed divergence result for pivot-based stop loss
      const divergenceResult = this.divergenceDetector.detectDetailed(
        candles,
        stochasticManager.getHistory('fast')
      );

      // Check all signal components
      const components: SignalComponents = {
        quadExtreme: this.checkQuadExtreme(stochIndicators),
        divergence: divergenceResult?.type ?? null,
        location: this.checkLocation(candles),
        rotation: this.checkRotation(stochasticManager)
      };

      // Generate signal based on components
      const signal = this.combineSignals(
        pair,
        components,
        candles[candles.length - 1],
        stochasticManager,
        divergenceResult
      );

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
   * Check Quad Extreme based on configured entry mode
   * - 'strict': All 4 stochastics must be in extreme zones (<20 or >80)
   * - 'relaxed': Fast+Medium in extreme zones (directional filtering done in combineSignals)
   */
  private checkQuadExtreme(stochastics: StochasticIndicators): boolean {
    if (this.config.entryMode === 'strict') {
      return this.checkQuadExtremeStrict(stochastics);
    } else {
      return this.checkQuadExtremeRelaxed(stochastics);
    }
  }

  /**
   * Strict mode: All 4 stochastics in extreme zones
   * Logs near-misses when 3 of 4 are aligned for analysis
   */
  private checkQuadExtremeStrict(stochastics: StochasticIndicators): boolean {
    const { fast, medium, slow, trend } = stochastics;

    // Check each stochastic individually
    const fastOversold = FinancialMath.lessThan(fast.k, 20);
    const mediumOversold = FinancialMath.lessThan(medium.k, 20);
    const slowOversold = FinancialMath.lessThan(slow.k, 20);
    const trendOversold = FinancialMath.lessThan(trend.k, 20);

    const fastOverbought = FinancialMath.greaterThan(fast.k, 80);
    const mediumOverbought = FinancialMath.greaterThan(medium.k, 80);
    const slowOverbought = FinancialMath.greaterThan(slow.k, 80);
    const trendOverbought = FinancialMath.greaterThan(trend.k, 80);

    // Count how many are in oversold/overbought
    const oversoldCount = [fastOversold, mediumOversold, slowOversold, trendOversold].filter(Boolean).length;
    const overboughtCount = [fastOverbought, mediumOverbought, slowOverbought, trendOverbought].filter(Boolean).length;

    const allExtremeOversold = oversoldCount === 4;
    const allExtremeOverbought = overboughtCount === 4;

    // Near-miss logging: 3 of 4 aligned but entry skipped (for analysis)
    if (oversoldCount === 3) {
      const missing = !fastOversold ? 'Fast' : !mediumOversold ? 'Medium' : !slowOversold ? 'Slow' : 'Trend';
      TradingLogger.info(
        `NEAR-MISS (Long): 3/4 stochastics oversold, missing ${missing} K - ` +
        `Fast: ${fast.k.toFixed(1)}, Medium: ${medium.k.toFixed(1)}, Slow: ${slow.k.toFixed(1)}, Trend: ${trend.k.toFixed(1)}`
      );
    }

    if (overboughtCount === 3) {
      const missing = !fastOverbought ? 'Fast' : !mediumOverbought ? 'Medium' : !slowOverbought ? 'Slow' : 'Trend';
      TradingLogger.info(
        `NEAR-MISS (Short): 3/4 stochastics overbought, missing ${missing} K - ` +
        `Fast: ${fast.k.toFixed(1)}, Medium: ${medium.k.toFixed(1)}, Slow: ${slow.k.toFixed(1)}, Trend: ${trend.k.toFixed(1)}`
      );
    }

    return allExtremeOversold || allExtremeOverbought;
  }

  /**
   * Relaxed mode: Only Fast+Medium must be in extreme zones
   * Slow+Trend act as directional filters (checked in combineSignals)
   */
  private checkQuadExtremeRelaxed(stochastics: StochasticIndicators): boolean {
    const { fast, medium } = stochastics;

    // Check if Fast+Medium are in extreme oversold (<20)
    const fastMediumOversold = FinancialMath.lessThan(fast.k, 20) &&
      FinancialMath.lessThan(medium.k, 20);

    // Check if Fast+Medium are in extreme overbought (>80)
    const fastMediumOverbought = FinancialMath.greaterThan(fast.k, 80) &&
      FinancialMath.greaterThan(medium.k, 80);

    return fastMediumOversold || fastMediumOverbought;
  }

  /**
   * Check directional alignment for relaxed mode
   * For longs: Slow+Trend must be >50 (bullish bias)
   * For shorts: Slow+Trend must be <50 (bearish bias)
   */
  private checkDirectionalFilter(direction: 'long' | 'short'): boolean {
    if (!this.lastStochastics || this.config.entryMode !== 'relaxed') {
      return true; // No filter in strict mode
    }

    const { slow, trend } = this.lastStochastics;

    if (direction === 'long') {
      // For longs: Slow and Trend should be >50 (bullish momentum)
      return FinancialMath.greaterThan(slow.k, 50) &&
        FinancialMath.greaterThan(trend.k, 50);
    } else {
      // For shorts: Slow and Trend should be <50 (bearish momentum)
      return FinancialMath.lessThan(slow.k, 50) &&
        FinancialMath.lessThan(trend.k, 50);
    }
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
    manager: StochasticManager,
    divergenceResult: DivergenceResult | null = null
  ): TradingSignal | null {
    const { quadExtreme, divergence, location, rotation } = components;

    // ================================================
    // EMBEDDED STOCHASTIC FILTER - Hard Block Logic
    // ================================================
    // Track consecutive bars where Trend K is embedded (>90 or <10)
    // When embedded for 3+ bars, hard block counter-trend entries entirely
    const trendHistory = manager.getHistory('trend');
    if (trendHistory.length > 0) {
      const lastTrend = trendHistory[trendHistory.length - 1];
      const isEmbeddedHigh = FinancialMath.greaterThan(lastTrend.k, 90);
      const isEmbeddedLow = FinancialMath.lessThan(lastTrend.k, 10);

      // Get or initialize per-pair embedded streak counters
      let streaks = this.embeddedStreaks.get(pair);
      if (!streaks) {
        streaks = { high: 0, low: 0 };
        this.embeddedStreaks.set(pair, streaks);
      }

      // Update embedded streak counters
      if (isEmbeddedHigh) {
        streaks.high++;
        streaks.low = 0; // Reset opposite streak
      } else if (isEmbeddedLow) {
        streaks.low++;
        streaks.high = 0; // Reset opposite streak
      } else {
        // Reset both streaks when not embedded
        streaks.high = 0;
        streaks.low = 0;
      }

      // HARD BLOCK: When embedded >90 for 3+ bars, block ALL short entries
      if (streaks.high >= this.EMBEDDED_STREAK_THRESHOLD) {
        if (divergence === 'bearish' || rotation === 'down') {
          TradingLogger.warn(
            `EMBEDDED BLOCK: Trend K >90 for ${streaks.high} consecutive bars - blocking short entry`
          );
          return null;
        }
      }

      // HARD BLOCK: When embedded <10 for 3+ bars, block ALL long entries
      if (streaks.low >= this.EMBEDDED_STREAK_THRESHOLD) {
        if (divergence === 'bullish' || rotation === 'up') {
          TradingLogger.warn(
            `EMBEDDED BLOCK: Trend K <10 for ${streaks.low} consecutive bars - blocking long entry`
          );
          return null;
        }
      }

      // Standard embedded check (less than 3 bars): require location confirmation
      if ((isEmbeddedHigh || isEmbeddedLow) &&
        streaks.high < this.EMBEDDED_STREAK_THRESHOLD &&
        streaks.low < this.EMBEDDED_STREAK_THRESHOLD) {
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

    // ================================================
    // RELAXED MODE: Directional Filter Check
    // ================================================
    // In relaxed mode, Slow+Trend must confirm direction
    if (this.config.entryMode === 'relaxed') {
      const direction = isLong ? 'long' : 'short';
      if (!this.checkDirectionalFilter(direction)) {
        TradingLogger.warn(
          `DIRECTIONAL FILTER: ${direction.toUpperCase()} blocked - Slow/Trend not aligned (need ${direction === 'long' ? '>50' : '<50'})`
        );
        return null;
      }
    }

    // Strength calculation using Decimal
    let strength = FinancialMath.decimal(0.5);
    if (quadExtreme) strength = strength.add(0.2);
    if (location) strength = strength.add(0.2);
    if (divergence) strength = strength.add(0.1);

    // Stop Loss calculation (Rule 4: Stops beyond divergence extreme + buffer)
    // Use the divergence pivot price when available, otherwise fall back to current candle
    let stopLoss: Decimal | undefined;
    const buffer = currentCandle.close.mul(0.001); // 0.1% buffer

    if (isLong) {
      // For longs: stop below the divergence low pivot (where the bullish divergence formed)
      if (divergenceResult && divergenceResult.type === 'bullish') {
        const pivotLowPrice = divergenceResult.pricePivots.last.price;
        stopLoss = pivotLowPrice.sub(buffer);
        TradingLogger.info(
          `Stop loss set below divergence pivot low: ${pivotLowPrice.toFixed(6)} - buffer = ${stopLoss.toFixed(6)}`
        );
      } else {
        // Fallback: use current candle low
        stopLoss = currentCandle.low.sub(buffer);
      }
    } else {
      // For shorts: stop above the divergence high pivot (where the bearish divergence formed)
      if (divergenceResult && divergenceResult.type === 'bearish') {
        const pivotHighPrice = divergenceResult.pricePivots.last.price;
        stopLoss = pivotHighPrice.add(buffer);
        TradingLogger.info(
          `Stop loss set above divergence pivot high: ${pivotHighPrice.toFixed(6)} + buffer = ${stopLoss.toFixed(6)}`
        );
      } else {
        // Fallback: use current candle high
        stopLoss = currentCandle.high.add(buffer);
      }
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

  /**
   * Check for partial or full exit based on Fast K stochastic levels
   * 
   * Scale-out logic:
   * - Fast K crosses 50: Close 50% (partial exit)
   * - Fast K hits 80/20: Close remaining (full exit)
   */
  public checkPartialExit(
    position: { direction: SignalDirection; pair: TradingPair; partialExitTaken?: boolean },
    stochastics: StochasticManager
  ): 'partial' | 'full' | null {
    const history = stochastics.getHistory('fast');
    if (history.length < 2) return null;

    const current = history[history.length - 1];
    const previous = history[history.length - 2];

    if (position.direction === 'long') {
      // Partial exit: Fast K crosses above 50 (first 50% scale-out)
      if (!position.partialExitTaken &&
        FinancialMath.greaterThanOrEqual(current.k, 50) &&
        FinancialMath.lessThan(previous.k, 50)) {
        return 'partial';
      }
      // Full exit: Fast K hits 80 (close remaining 50%)
      if (FinancialMath.greaterThanOrEqual(current.k, 80)) {
        return 'full';
      }
    } else if (position.direction === 'short') {
      // Partial exit: Fast K crosses below 50
      if (!position.partialExitTaken &&
        FinancialMath.lessThanOrEqual(current.k, 50) &&
        FinancialMath.greaterThan(previous.k, 50)) {
        return 'partial';
      }
      // Full exit: Fast K hits 20
      if (FinancialMath.lessThanOrEqual(current.k, 20)) {
        return 'full';
      }
    }
    return null;
  }

  public getSignalStats(_pair: TradingPair): Record<string, unknown> {
    // TODO: Implement signal statistics per pair
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
  private config: StrategyConfig;

  // Cooldown tracking: timestamp until which new signals are blocked after stop-out
  // Changed from bar-count to timestamp-based to handle candle gaps correctly
  private cooldownUntil: Map<TradingPair, number> = new Map();
  private readonly COOLDOWN_MS = 3 * 3 * 60 * 1000; // 3 bars × 3 min × 60 sec × 1000 ms = 9 minutes

  constructor(pairs: TradingPair[], config?: Partial<StrategyConfig>) {
    this.config = {
      entryMode: config?.entryMode ?? 'strict' // Default to strict for high-conviction setups
    };
    pairs.forEach(pair => {
      this.strategies.set(pair, new SuperSignalStrategy(this.config));
      this.managers.set(pair, new StochasticManager());
      this.candleBuffers.set(pair, []);
      this.cooldownUntil.set(pair, 0); // No cooldown initially
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

    let isNewBar = false;

    // Check if this is an update to the current candle or a new one
    if (buffer.length > 0) {
      const lastCandle = buffer[buffer.length - 1];
      if (lastCandle.timestamp === candle.timestamp) {
        // Update existing candle (intrabar update)
        buffer[buffer.length - 1] = candle;
      } else {
        // New candle
        isNewBar = true;
        buffer.push(candle);
        if (buffer.length > this.MAX_CANDLES) {
          buffer.shift();
        }
      }
    } else {
      isNewBar = true;
      buffer.push(candle);
    }

    // Check timestamp-based cooldown (handles candle gaps correctly)
    const cooldownTimestamp = this.cooldownUntil.get(pair) ?? 0;
    const now = Date.now();

    if (now < cooldownTimestamp) {
      // Still in cooldown - log remaining time on new bars
      if (isNewBar) {
        const remainingMs = cooldownTimestamp - now;
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        TradingLogger.info(
          `Cooldown for ${pair}: ${remainingMinutes} minute(s) remaining (until ${new Date(cooldownTimestamp).toISOString()})`
        );
      }
      return null; // In cooldown, no new signals
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

  /**
   * Check exits with type information for partial/full exit handling
   * Returns array of pairs with their exit type
   */
  public checkExitsWithType(
    positions: Array<{ direction: SignalDirection; pair: TradingPair; partialExitTaken?: boolean }>
  ): Array<{ pair: TradingPair; exitType: 'partial' | 'full' }> {
    const exits: Array<{ pair: TradingPair; exitType: 'partial' | 'full' }> = [];

    for (const pos of positions) {
      const strategy = this.strategies.get(pos.pair);
      const manager = this.managers.get(pos.pair);

      if (strategy && manager) {
        const exitType = strategy.checkPartialExit(pos, manager);
        if (exitType) {
          exits.push({ pair: pos.pair, exitType });
        }
      }
    }

    return exits;
  }

  public getStrategy(pair: TradingPair): SuperSignalStrategy | undefined {
    return this.strategies.get(pair);
  }

  /**
   * Trigger cooldown after a stop-out (not strategy exit or TP)
   * Blocks new signals until timestamp (COOLDOWN_MS from now)
   */
  public triggerCooldown(pair: TradingPair): void {
    const cooldownUntilTimestamp = Date.now() + this.COOLDOWN_MS;
    this.cooldownUntil.set(pair, cooldownUntilTimestamp);

    const cooldownMinutes = this.COOLDOWN_MS / 60000;
    TradingLogger.warn(
      `Cooldown triggered for ${pair}: blocking signals for ${cooldownMinutes} minutes (until ${new Date(cooldownUntilTimestamp).toISOString()})`
    );
  }

  /**
   * Get remaining cooldown time in milliseconds for a pair
   * Returns 0 if no cooldown active
   */
  public getCooldown(pair: TradingPair): number {
    const cooldownTimestamp = this.cooldownUntil.get(pair) ?? 0;
    const now = Date.now();
    return Math.max(0, cooldownTimestamp - now);
  }
}
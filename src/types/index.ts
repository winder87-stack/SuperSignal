// Core type definitions for Hyperliquid Super Signal Trading Bot

import { Decimal } from 'decimal.js';

// Trading Pairs (10x leverage)
export const TRADING_PAIRS = [
  'ETH-USDC',
  'BTC-USDC',
  'HYPE-USDC',
  'SOL-USDC',
  'FARTCOIN-USDC',
  'BNB-USDC',
  'DOGE-USDC'
] as const;

export type TradingPair = typeof TRADING_PAIRS[number];

// Stochastic Oscillator Configurations
export interface StochasticConfig {
  kPeriod: number;
  dPeriod: number;
  name: string;
}

export const STOCHASTIC_CONFIGS = {
  fast: { kPeriod: 9, dPeriod: 3, name: 'Fast' },
  medium: { kPeriod: 14, dPeriod: 3, name: 'Medium' },
  slow: { kPeriod: 40, dPeriod: 4, name: 'Slow' },
  trend: { kPeriod: 60, dPeriod: 10, name: 'Trend' }
} as const;

// Trading Signal Types
export type SignalDirection = 'long' | 'short' | 'neutral';

// Market Data Types
export interface Candle {
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

export interface MarketData {
  pair: TradingPair;
  candles: Candle[];
  lastUpdate: number;
}

// Stochastic Indicator Values
export interface StochasticValue {
  k: Decimal;
  d: Decimal;
  timestamp: number;
}

export interface StochasticIndicators {
  fast: StochasticValue;
  medium: StochasticValue;
  slow: StochasticValue;
  trend: StochasticValue;
}

// Trading Signal Components
export interface SignalComponents {
  // Quad Extreme: All 4 stochastics in extreme zones
  quadExtreme: boolean;

  // Divergence: Price vs stochastic divergence
  divergence: 'bullish' | 'bearish' | null;

  // Location: Support/Resistance levels
  location: 'support' | 'resistance' | null;

  // Rotation: Fast stochastic curling direction
  rotation: 'up' | 'down' | null;
}

// Trading Signal
export interface TradingSignal {
  pair: TradingPair;
  direction: SignalDirection;
  strength: number; // 0-1 confidence score
  components: SignalComponents;
  timestamp: number;
  price: Decimal;
}

// Position Types
export interface Position {
  pair: TradingPair;
  direction: SignalDirection;
  size: Decimal;
  entryPrice: Decimal;
  stopLoss: Decimal;
  timestamp: number;
  signalId: string;
}

// Order Types
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderSide = 'buy' | 'sell';

export interface Order {
  id: string;
  pair: TradingPair;
  type: OrderType;
  side: OrderSide;
  size: Decimal;
  price?: Decimal;
  timestamp: number;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
}

// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Risk Management
export interface RiskConfig {
  maxPositionSize: Decimal; // Max size per position
  maxTotalExposure: Decimal; // Max total exposure across all positions
  stopLossPercentage: number; // Stop loss as percentage (e.g., 0.02 for 2%)
  maxDrawdown: number; // Max drawdown before halting
}

// Performance Metrics
export interface PerformanceMetrics {
  totalPnL: Decimal;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgWin: Decimal;
  avgLoss: Decimal;
}

// Configuration
export interface BotConfig {
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  riskConfig: RiskConfig;
  enabledPairs: TradingPair[];
}

// WebSocket Message Types
export interface WsMessage {
  type: 'market_data' | 'order_update' | 'position_update' | 'error';
  data: any;
  timestamp: number;
}
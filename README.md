# Hyperliquid Super Signal Trading Bot

A sophisticated trading bot implementing the Super Signal strategy for Hyperliquid exchange using stochastic oscillators.

## Features

- **Super Signal Strategy**: Quad Extreme + Divergence + Location + Rotation entry logic
- **4 Stochastic Oscillators**: Fast (K9/D3), Medium (K14/D3), Slow (K40/D4), Trend (K60/D10)
- **Financial Precision**: All calculations use decimal.js for accurate money handling
- **Risk Management**: Built-in stop-loss and position sizing
- **Multi-Pair Support**: ETH, BTC, HYPE, SOL, FARTCOIN, BNB, DOGE vs USDC (≥10x leverage)

## Trading Pairs (≥10x leverage)

- ETH-USDC
- BTC-USDC
- HYPE-USDC
- SOL-USDC
- FARTCOIN-USDC
- BNB-USDC
- DOGE-USDC

## Strategy Rules

### Stochastic Oscillators
| Name   | K Period | D Period |
|--------|----------|----------|
| Fast   | 9        | 3        |
| Medium | 14       | 3        |
| Slow   | 40       | 4        |
| Trend  | 60       | 10       |

### Levels
- Overbought: 80, Oversold: 20
- Embedded: 90/10

### Entry Signal = Quad Extreme + Divergence + Location + Rotation
- **Long**: OS (<20) + Bullish Div + Support + Fast curling up
- **Short**: OB (>80) + Bearish Div + Resistance + Fast curling down

### Exit
- **Longs**: Fast stoch reaches ~80
- **Shorts**: Fast stoch reaches ~20
- **Stop**: Beyond divergence extreme

## Installation

```bash
npm install
```

## Configuration

1. Copy `.env.example` to `.env`
2. Configure your Hyperliquid API credentials
3. Adjust risk management settings

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm run start
```

### Testing
```bash
npm test
```

## Project Structure

```
src/
├── types/          # TypeScript type definitions
├── utils/          # Financial math and logging utilities
├── indicators/     # Stochastic oscillator and pivot implementations
├── strategies/     # Super Signal strategy logic
├── core/           # Trading engine
├── exchange/       # Hyperliquid API clients and WebSocket
│   └── hyperliquid/
├── trading/        # Order book management and analysis
│   └── order-book/
├── risk/           # Risk management
└── index.ts        # Main bot entry point

tests/
├── unit/           # Unit tests
└── integration/    # Integration tests

scripts/            # Utility scripts
plans/              # Strategy and architecture documentation
```

## Safety Rules (Non-negotiable)

- ✅ ALWAYS use decimal.js for prices, sizes, balances
- ✅ NEVER use JavaScript Number for money
- ✅ API values must be strings: `price.toString()`
- ✅ NEVER remove risk management code
- ✅ NEVER hardcode private keys
- ✅ ALWAYS include stop-loss on every position
- ✅ ALWAYS validate inputs before API calls

## Code Style

- Async/await only, no callbacks
- Explicit return types on all functions
- try/catch for ALL async operations

## Development Status

- ✅ Project structure and types
- ✅ Financial math utilities (decimal.js)
- ✅ Stochastic oscillator indicators
- ✅ Pivot detection (support/resistance)
- ✅ Super Signal strategy framework
- ✅ Hyperliquid API integration
- ✅ Trading execution engine
- ✅ WebSocket streaming
- ✅ Risk management with dynamic position sizing
- ✅ Stop loss order placement (normalTpsl)
- ✅ Order book analysis
- 🔄 Backtesting system
- 🔄 Performance monitoring

## Disclaimer

This is a sophisticated trading bot. Use at your own risk. Always test thoroughly and never risk more than you can afford to lose.
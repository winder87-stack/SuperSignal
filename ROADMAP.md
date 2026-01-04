# Hyperliquid Super Signal - Development Roadmap

This document outlines the proposed roadmap for the evolution of the Hyperliquid Super Signal trading bot, based on a comprehensive codebase analysis.

## 1. Critical Stability & Safety Fixes

### [ ] State Reconciliation on Startup

- **Issue**: Currently, `TradingEngine` starts with an empty `positions` map. If the bot is restarted while trades are open on the exchange, the bot will be unaware of them. It will fail to manage them (no trailing stops) and might open conflicting positions.
- **Solution**:
  - On startup (in `HyperliquidSuperSignal.start`), fetch open positions from Hyperliquid API (`getUserState`).
  - Reconstruct `Position` objects and populate `TradingEngine`'s state.
  - Re-calculate Stop Loss / Take Profit orders if they are missing locally but exist on exchange, or verify they match.

## 2. Infrastructure & Connectivity (The "User Request")

### [ ] MCP Server (Model Context Protocol)

- **Goal**: Enable LLMs (like Claude/ChatGPT/Gemini) to interact with the running bot directly.
- **Implementation**: Build a TypeScript MCP server (using `@modelcontextprotocol/sdk`) that exposes tools:
  - `get_status()`: Returns running state, active pairs, PnL.
  - `get_positions()`: Returns detailed open positions.
  - `get_logs(n)`: Returns recent log entries.
  - `close_all_positions()`: Emergency switch.
  - `update_config()`: Modify risk parameters dynamically.
- **Benefit**: "Chat to your bot" capabilities, automated debugging agents.

### [ ] Internal WebSocket Server

- **Goal**: Broadcast real-time internal state to external UIs/Dashboards.
- **Implementation**: A transparent WebSocket server (`ws` library) broadcasting:
  - `price_update`: Consolidated price/indicator data.
  - `signal_detected`: When Super Signal fires.
  - `position_update`: Entry/Exit/SL change events.
- **Benefit**: Decouples the bot from the UI.

### [ ] Persistence Layer

- **Goal**: Store trade history, signals, and performance metrics permanently.
- **Implementation**: SQLite database (using `better-sqlite3` or `prisma`).
- **Data to Store**:
  - `signals`: All generated signals (even rejected ones).
  - `trades`: Executed trades with entry/exit prices and PnL.
  - `metrics`: Daily PnL snapshots.

## 3. Advanced Features

### [ ] Web Dashboard

- **Goal**: Specific UI to visualize the "Super Signal".
- **Features**:
  - Real-time chart with Stochastic indicators overlaid.
  - Active positions table.
  - Manual override controls.
  - Log viewer.
- **Tech**: Next.js (as suggested by guidelines) or a simple Vite React app connecting to the Internal WebSocket Server.

### [ ] Backtesting Engine

- **Goal**: Validate strategy against historical data.
- **Implementation**:
  - Extend `TradingEngine` to work in "Simulation Mode".
  - Feed historical candles (from `fetchCandles.ts`) instead of live WS data.
  - Record hypothetical PnL relative to slippage/fees.

## 4. Immediate Next Steps (Proposed)

1. **Implement State Reconciliation** (Critical for safety).
2. **Build MCP Server + WebSocket Server** (To fulfill user request).

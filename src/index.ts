// Hyperliquid Super Signal - Main Entry Point
import { TradingLogger } from './utils/logger.js';
import { TRADING_PAIRS, TradingPair, Candle } from './types/index.js';
import { StochasticManager } from './indicators/stochastic.js';
import { SignalProcessor } from './strategies/superSignal.js';
import { HyperLiquidClient } from './exchange/hyperliquid/index.js';
import { TradingEngine } from './core/engine.js';
import { RiskManager } from './risk/manager.js';
import { Decimal } from 'decimal.js';
import dotenv from 'dotenv';
import { OrderBookManager, OrderBookAnalyzer } from './trading/order-book/index.js';
import type { OrderBookMetrics, ExecutionParameters, SlippageEstimate } from './trading/order-book/types.js';
import { BotWebSocketServer } from './api/websocket.js';

import { BotMcpServer } from './api/mcp.js';
import { DatabaseService } from './core/database.js';

dotenv.config();

class HyperliquidSuperSignal {
  private engine: TradingEngine;
  private client: HyperLiquidClient;
  private isRunning: boolean = false;
  private orderBookManager: OrderBookManager;
  private orderBookAnalyzer: OrderBookAnalyzer;
  private orderBookMetrics: Map<string, OrderBookMetrics> = new Map();
  private wsServer: BotWebSocketServer;
  private mcpServer: BotMcpServer;
  private databaseService: DatabaseService;

  constructor() {
    TradingLogger.info("Initializing Hyperliquid Super Signal Trading Bot (REFACTORED)");

    // Initialize Order Book Components
    this.orderBookManager = new OrderBookManager();
    this.orderBookAnalyzer = new OrderBookAnalyzer();

    // Initialize Risk Manager (configured for $1000 testnet account)
    const riskConfig = {
      maxPositionSize: new Decimal(200),       // $200 per position (allows ~5 positions)
      maxTotalExposure: new Decimal(800),      // $800 max total (80% of account)
      stopLossPercentage: new Decimal(0.02),   // 2% SL
      maxDrawdown: new Decimal(100),           // $100 max daily loss (10% of account)
      riskPercentage: new Decimal(0.10)        // Risk 10% of account per trade ($100)
    };
    const riskManager = new RiskManager(riskConfig);

    // Initialize Signal Processor
    const signalProcessor = new SignalProcessor([...TRADING_PAIRS]);

    // Initialize Database Service
    const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : 'data/bot.db';
    this.databaseService = new DatabaseService(dbPath);

    // Initialize HyperLiquid Client
    const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
    if (!privateKey) {
      TradingLogger.warn("HYPERLIQUID_PRIVATE_KEY not found in .env. Execution will fail.");
    }
    // Use testnet based on env var, default to true for safety
    const isTestnet = process.env.HYPERLIQUID_TESTNET !== 'false';
    this.client = new HyperLiquidClient(privateKey || "", isTestnet);

    // Initialize Trading Engine with order book components
    this.engine = new TradingEngine(
      this.client,
      signalProcessor,
      riskManager,
      this.orderBookManager,
      this.orderBookAnalyzer,
      this.databaseService
    );

    // Initialize Internal WebSocket Server
    const wsPort = process.env.NODE_ENV === 'test' ? 0 : 8080;
    this.wsServer = new BotWebSocketServer(wsPort);

    // Initialize MCP Server
    this.mcpServer = new BotMcpServer(this.engine);

    TradingLogger.info(`Bot ready for ${TRADING_PAIRS.length} pairs (TESTNET: true)`);
  }

  /**
   * Start the trading bot
   */
  public async start(): Promise<void> {
    try {
      TradingLogger.info("Starting Trading Bot...");
      this.isRunning = true;

      // Start WebSocket connections (this initializes asset index mappings)
      await this.client.connect();

      // Start MCP Server
      await this.mcpServer.start();

      // NEW: Reconcile state with exchange
      try {
        const address = this.client.api.getAddress();
        TradingLogger.info(`Fetching state for ${address}...`);

        const [userState, openOrders] = await Promise.all([
          this.client.api.getUserState(address),
          this.client.api.getOpenOrders(address)
        ]);

        this.engine.reconcilePositions(userState, openOrders);
      } catch (error) {
        TradingLogger.error(`Failed to reconcile state: ${(error as Error).message}`);
        // We don't throw here, allowing bot to start, but with warning
      }



      // Hook up Engine Events to WebSocket Broadcast
      this.engine.on('position_opened', (data) => {
        this.wsServer.broadcast('position_update', { status: 'opened', ...data });
      });

      this.engine.on('position_closed', (data) => {
        this.wsServer.broadcast('position_update', { status: 'closed', ...data });
      });

      this.engine.on('trailing_stop_updated', (data) => {
        this.wsServer.broadcast('position_update', { status: 'updated', ...data });
      });

      // Log asset mappings
      const mappings = this.client.assetIndex.getAllMappings();
      TradingLogger.info(`Asset mappings loaded: ${mappings.symbolToIndex.size} assets`);

      // Subscribe to Market Data
      for (const pair of TRADING_PAIRS) {
        const coin = pair.split('-')[0]; // ETH-USDC -> ETH
        this.client.ws.subscribeToL2Book(coin);
        this.client.ws.subscribeToCandles(coin, '3m'); // Subscribe to 3m candles for strategy
      }

      // Handle Market Data
      this.client.ws.on('l2Book', (book) => {
        // Update order book with new data
        this.orderBookManager.updateFromL2Book(book);

        // Get the updated order book
        const orderBook = this.orderBookManager.getOrderBook(book.coin);
        if (orderBook) {
          // Calculate metrics
          const metrics = this.orderBookAnalyzer.calculateMetrics(orderBook);
          if (metrics) {
            // Store metrics
            this.orderBookMetrics.set(book.coin, metrics);

            // Log key metrics
            TradingLogger.debug(
              `L2Book update for ${book.coin}: ` +
              `spread=${metrics.bidAskSpreadPercentage.toFixed(4)}%, ` +
              `midPrice=${metrics.midPrice.toFixed(2)}, ` +
              `bidVol=${metrics.totalBidVolume.toFixed(2)}, ` +
              `askVol=${metrics.totalAskVolume.toFixed(2)}`
            );
          }
        }
      });

      this.client.ws.on('candle', (rawCandle: any) => {
        // Parse WS candle into our Candle type
        // HyperLiquid candle format: { s: coin, t: open_time, T: close_time, i: interval, o, h, l, c, v, n }
        const coin = rawCandle.s;
        const pair = TRADING_PAIRS.find(p => p.startsWith(coin + '-')) as TradingPair | undefined;

        if (!pair) return;

        const candle: Candle = {
          timestamp: rawCandle.t,
          open: new Decimal(rawCandle.o),
          high: new Decimal(rawCandle.h),
          low: new Decimal(rawCandle.l),
          close: new Decimal(rawCandle.c),
          volume: new Decimal(rawCandle.v)
        };

        // Check order book data availability before processing signal
        const orderBook = this.orderBookManager.getOrderBook(coin);
        if (orderBook) {
          const metrics = this.orderBookMetrics.get(coin);
          if (metrics) {
            // Check if market is thin (avoid trading in thin markets)
            const isThin = this.orderBookAnalyzer.isThinMarket(orderBook, 1000);
            if (isThin) {
              TradingLogger.warn(`Thin market detected for ${coin}, skipping signal processing`);
              return;
            }

            // Log order book metrics for signal processing
            TradingLogger.debug(
              `Processing signal for ${coin} with order book: ` +
              `spread=${metrics.bidAskSpreadPercentage.toFixed(4)}%, ` +
              `midPrice=${metrics.midPrice.toFixed(2)}, ` +
              `totalVol=${(metrics.totalBidVolume + metrics.totalAskVolume).toFixed(2)}`
            );
          }
        } else {
          TradingLogger.warn(`No order book data available for ${coin}, signal processing may be suboptimal`);
        }

        this.engine.handleCandle(pair, candle).catch(err => {
          TradingLogger.error(`Engine Error (${pair}): ${err.message}`);
        });

        // Broadcast candle update
        this.wsServer.broadcast('price_update', {
          pair,
          price: candle.close,
          candle,
          timestamp: Date.now()
        });
      });

      this.client.ws.on('userFill', (fill) => {
        TradingLogger.info(`Order Filled: ${fill.coin} ${fill.side} ${fill.sz} @ ${fill.px}`);
      });

      // Add event listener for order book updates
      this.orderBookManager.on('orderBookUpdate', (event) => {
        const metrics = this.orderBookAnalyzer.calculateMetrics(event.orderBook);
        if (metrics) {
          this.orderBookMetrics.set(event.coin, metrics);
          TradingLogger.debug(
            `Order book updated for ${event.coin}: ` +
            `spread=${metrics.bidAskSpreadPercentage.toFixed(4)}%, ` +
            `midPrice=${metrics.midPrice.toFixed(2)}`
          );
        }
      });

      TradingLogger.info("Bot started successfully.");

    } catch (error) {
      TradingLogger.logError(error as Error, "Failed to start bot");
      throw error;
    }
  }

  /**
   * Stop the trading bot
   */
  public async stop(): Promise<void> {
    TradingLogger.info("Stopping Hyperliquid Super Signal Bot...");
    this.isRunning = false;

    // Remove event listeners from orderBookManager
    this.orderBookManager.removeAllListeners('orderBookUpdate');

    // Clear order book metrics
    this.orderBookMetrics.clear();

    // Close WebSocket Server
    this.wsServer.close();

    // Close Database
    this.databaseService.close();

    this.client.disconnect();

    TradingLogger.info("Bot stopped");
  }

  /**
   * Get bot status
   */
  public getStatus(): {
    running: boolean;
    pairs: string[];
    version: string;
  } {
    return {
      running: this.isRunning,
      pairs: [...TRADING_PAIRS],
      version: "1.0.0"
    };
  }






}

// Main execution
async function main() {
  const bot = new HyperliquidSuperSignal();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    TradingLogger.info("Received SIGINT, shutting down gracefully...");
    await bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    TradingLogger.info("Received SIGTERM, shutting down gracefully...");
    await bot.stop();
    process.exit(0);
  });

  try {
    await bot.start();

    // Keep the process running
    TradingLogger.info("Bot is running. Press Ctrl+C to stop.");

  } catch (error) {
    TradingLogger.logError(error as Error, "Bot failed to start");
    process.exit(1);
  }
}

// Start the bot if this is the main module (ES module compatible)
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  });
}

export { HyperliquidSuperSignal };
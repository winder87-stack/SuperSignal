// Hyperliquid Super Signal - Main Entry Point
import { TradingLogger, generateRequestId } from './utils/logger.js';
import { intervalManager } from './utils/intervalManager.js';
import { TRADING_PAIRS, TradingPair, Candle } from './types/index.js';
import { SignalProcessor } from './strategies/superSignal.js';
import { HyperLiquidClient } from './exchange/hyperliquid/index.js';
import { TradingEngine } from './core/engine.js';
import { RiskManager } from './risk/manager.js';
import { Decimal } from 'decimal.js';
import dotenv from 'dotenv';
import { OrderBookManager, OrderBookAnalyzer } from './trading/order-book/index.js';
import { BotWebSocketServer } from './api/websocket.js';

import { BotMcpServer } from './api/mcp.js';
import { DatabaseService } from './core/database.js';
import { DryRunManager } from './core/dryRunManager.js';

dotenv.config();

// Initialize IntervalManager for centralized interval management
intervalManager.initialize();

export class HyperliquidSuperSignal {
  private engine: TradingEngine;
  private client: HyperLiquidClient;
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;
  private orderBookManager: OrderBookManager;
  private orderBookAnalyzer: OrderBookAnalyzer;
  private wsServer: BotWebSocketServer;
  private mcpServer: BotMcpServer;
  private databaseService: DatabaseService;
  private dryRunManager?: DryRunManager;

  constructor() {
    // Check for dry-run mode
    const isDryRun = process.env.DRY_RUN === 'true';
    const dryRunBalance = new Decimal(process.env.DRY_RUN_BALANCE || '200');

    TradingLogger.setComponent('TradingBot');
    const requestId = generateRequestId();
    TradingLogger.setRequestId(requestId);

    if (isDryRun) {
      TradingLogger.info(`Initializing Hyperliquid Super Signal Trading Bot [DRY-RUN MODE]`, {
        requestId,
        dryRunBalance: dryRunBalance.toFixed(2)
      });
    } else {
      TradingLogger.info("Initializing Hyperliquid Super Signal Trading Bot (REFACTORED)", { requestId });
    }

    // Initialize Order Book Components
    this.orderBookManager = new OrderBookManager();
    this.orderBookAnalyzer = new OrderBookAnalyzer();

    // Initialize Risk Manager (configured for $200 account, high-conviction quality-over-quantity approach)
    const riskConfig = {
      maxPositionSize: new Decimal(process.env.RISK_MAX_POSITION_SIZE || '150'),       // $150 per position (single position focus)
      maxTotalExposure: new Decimal(process.env.RISK_MAX_TOTAL_EXPOSURE || '150'),     // $150 max total (single position focus)
      stopLossPercentage: new Decimal(process.env.RISK_STOP_LOSS_PERCENTAGE || '0.02'), // 2% fallback stop
      maxDrawdown: new Decimal(process.env.RISK_MAX_DRAWDOWN || '0.20'),               // 20% max drawdown ($40 halt for $200 account)
      riskPercentage: new Decimal(process.env.RISK_PERCENTAGE || '0.05'),              // Risk 5% of account per trade ($10 for A+ setups)
      maxConcurrentPositions: 1                                                         // Single position focus
    };
    const riskManager = new RiskManager(riskConfig);

    // Initialize Signal Processor with entry mode from env or default to 'strict' (all 4 stochastics must be in extreme)
    const entryMode = (process.env.STRATEGY_ENTRY_MODE === 'relaxed' ? 'relaxed' : 'strict') as 'strict' | 'relaxed';
    const signalProcessor = new SignalProcessor([...TRADING_PAIRS], { entryMode });

    // Initialize Database Service
    const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : 'data/bot.db';
    this.databaseService = new DatabaseService(dbPath);

    // Initialize DryRunManager if in dry-run mode
    if (isDryRun) {
      this.dryRunManager = new DryRunManager({
        initialBalance: dryRunBalance,
        slippagePercent: new Decimal(0.0005), // 0.05% slippage
        dataPath: 'data/dry-run-results.json',
        riskConfig: riskConfig
      });
    }

    // Initialize HyperLiquid Client
    const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
    if (!privateKey && !isDryRun) {
      TradingLogger.warn("HYPERLIQUID_PRIVATE_KEY not found in .env. Execution will fail.");
    }
    // Use testnet based on env var, default to true for safety
    const isTestnet = process.env.HYPERLIQUID_TESTNET !== 'false';
    this.client = new HyperLiquidClient(privateKey || "", isTestnet);

    // Initialize Trading Engine with order book components and optional dry-run manager
    this.engine = new TradingEngine(
      this.client,
      signalProcessor,
      riskManager,
      this.orderBookManager,
      this.orderBookAnalyzer,
      this.databaseService,
      this.dryRunManager
    );

    // Initialize Internal WebSocket Server
    const wsPort = process.env.NODE_ENV === 'test' ? 0 : 8080;
    this.wsServer = new BotWebSocketServer(wsPort);

    // Initialize MCP Server
    this.mcpServer = new BotMcpServer(this.engine);

    const modeStr = isDryRun ? 'DRY-RUN' : (isTestnet ? 'TESTNET' : 'MAINNET');
    TradingLogger.info(`Bot ready for ${TRADING_PAIRS.length} pairs (${modeStr})`, {
      pairs: TRADING_PAIRS,
      mode: modeStr
    });
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
        // Mask address for security - show first 6 and last 4 chars
        const maskedAddress = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
        TradingLogger.info(`Fetching state for ${maskedAddress}...`);

        const [userState, openOrders] = await Promise.all([
          this.client.api.getUserState(address),
          this.client.api.getOpenOrders(address)
        ]);

        this.engine.reconcilePositions(userState, openOrders);
      } catch (error) {
        TradingLogger.logError(error, "Failed to reconcile state");
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

      // Initialize dry-run manager state if in dry-run mode
      if (this.dryRunManager) {
        await this.dryRunManager.initialize();
        this.dryRunManager.startReporting();
      }

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
        // Delegate order book processing to the engine
        this.engine.updateOrderBook(book);
      });

      this.client.ws.on('candle', (rawCandle: { s: string; t: number; o: string; h: string; l: string; c: string; v: string }) => {
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

        this.engine.handleCandle(pair, candle).catch(err => {
          TradingLogger.logError(err, `Engine Error (${pair})`);
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
        TradingLogger.info(`Order Filled: ${fill.coin} ${fill.side} ${fill.sz} @ ${fill.px}`, {
          coin: fill.coin,
          side: fill.side,
          size: fill.sz,
          price: fill.px,
          closedPnl: fill.closedPnl
        });
      });

      // Order book updates are now handled within the engine via updateOrderBook

      TradingLogger.info("Bot started successfully.");

    } catch (error) {
      TradingLogger.logError(error, "Failed to start bot");
      throw error;
    }
  }

  /**
   * Stop the trading bot gracefully
   * CRITICAL FIX: Remove all event listeners to prevent memory leaks
   */
  public async stop(): Promise<void> {
    if (this.isShuttingDown) {
      TradingLogger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    TradingLogger.info("Initiating graceful shutdown...");

    // 1. Stop accepting new signals
    this.isRunning = false;
    TradingLogger.info('✓ Stopped accepting new signals');

    // 2. Wait briefly for any in-flight engine operations to complete (max 30 seconds)
    // The engine handles its own async operations internally
    try {
      await new Promise((resolve, _reject) => {
        const timeout = setTimeout(() => {
          TradingLogger.warn('Timeout waiting for operations, proceeding with shutdown');
          resolve(undefined);
        }, 30000);

        // Allow brief grace period for operations to complete
        setTimeout(() => {
          clearTimeout(timeout);
          resolve(undefined);
        }, 2000);
      });
      TradingLogger.info('✓ In-flight operations completed');
    } catch {
      TradingLogger.warn('Error waiting for operations');
    }

    // 3. Close WebSocket connections
    TradingLogger.info('Closing WebSocket connections...');
    this.client.disconnect();
    TradingLogger.info('✓ WebSocket connections closed');

    // 4. Close internal WebSocket server
    TradingLogger.info('Closing internal WebSocket server...');
    this.wsServer.close();
    TradingLogger.info('✓ Internal WebSocket server closed');

    // 5. Stop dry-run manager and persist state
    if (this.dryRunManager) {
      TradingLogger.info('Saving dry-run state...');
      await this.dryRunManager.stop();
      TradingLogger.info('✓ Dry-run state saved');
    }

    // 6. Stop MCP server (if it has a stop method)
    if ('stop' in this.mcpServer && typeof this.mcpServer.stop === 'function') {
      TradingLogger.info('Stopping MCP server...');
      await this.mcpServer.stop();
      TradingLogger.info('✓ MCP server stopped');
    }

    // 7. Close database
    TradingLogger.info('Closing database...');
    await this.databaseService.close();
    TradingLogger.info('✓ Database closed');

    // 8. Allow brief time for final logs to flush
    TradingLogger.info('Shutdown complete ✓');
    await new Promise(resolve => setTimeout(resolve, 100));

    // CRITICAL FIX: Remove all event listeners to prevent memory leaks
    this.engine.removeAllListeners();
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
async function main(): Promise<void> {
  const bot = new HyperliquidSuperSignal();

  // Enhanced graceful shutdown handlers
  // CRITICAL FIX: Remove process.exit() from shutdown handler to allow proper cleanup
  const shutdown = async (signal: string): Promise<void> => {
    TradingLogger.info(`Received ${signal} signal`);
    try {
      await bot.stop();
      TradingLogger.info('Shutdown successful');
      // CRITICAL FIX: Don't call process.exit() here - let caller handle shutdown
    } catch (error) {
      TradingLogger.logError(error, "Shutdown error");
      // CRITICAL FIX: Don't call process.exit() here - let caller handle shutdown
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    TradingLogger.logError(error, "Uncaught exception");
    shutdown('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    TradingLogger.error(`Unhandled rejection: ${String(reason)}`);
    shutdown('unhandledRejection').catch(() => process.exit(1));
  });

  try {
    await bot.start();

    // Keep the process running
    TradingLogger.info("Bot is running. Press Ctrl+C to stop.");

  } catch (error) {
    TradingLogger.logError(error, "Bot failed to start");
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
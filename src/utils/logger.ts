// Logging utilities for comprehensive monitoring
import winston from 'winston';
import path from 'path';

// Custom log levels for trading
const customLevels = {
  error: 0,
  warn: 1,
  info: 2,
  trade: 3, // Trading signals and executions
  signal: 4, // Indicator signals
  debug: 5,
  trace: 6
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  trade: 'blue',
  signal: 'cyan',
  debug: 'magenta',
  trace: 'gray'
};

winston.addColors(colors);

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');

// Configure winston logger
export const logger = winston.createLogger({
  levels: customLevels,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'hyperliquid-super-signal' },
  transports: [
    // Error log file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error'
    }),
    // Combined log file
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log')
    }),
    // Console output for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.simple()
      ),
      level: process.env.NODE_ENV === 'production' ? 'info' : 'trace',
      stderrLevels: ['error', 'warn', 'info', 'trade', 'signal', 'debug', 'trace'] // specific levels calling stderr
    })
  ]
});

// Specialized logging functions
export class TradingLogger {
  private static recentLogs: Array<{ level: string; message: string; timestamp: number }> = [];
  private static MAX_LOGS = 50;

  private static addToBuffer(level: string, message: string): void {
    this.recentLogs.unshift({ level, message, timestamp: Date.now() });
    if (this.recentLogs.length > this.MAX_LOGS) {
      this.recentLogs.pop();
    }
  }

  static getRecentLogs(count: number = 20): Array<{ level: string; message: string; timestamp: number }> {
    return this.recentLogs.slice(0, count);
  }
  static error(message: string, meta?: any): void {
    logger.error(message, meta);
    this.addToBuffer('error', message);
  }

  static warn(message: string, meta?: any): void {
    logger.warn(message, meta);
    this.addToBuffer('warn', message);
  }

  static info(message: string, meta?: any): void {
    logger.info(message, meta);
    this.addToBuffer('info', message);
  }

  static trade(message: string, meta?: any): void {
    logger.log('trade', message, meta);
    this.addToBuffer('trade', message);
  }

  static signal(message: string, meta?: any): void {
    logger.log('signal', message, meta);
    this.addToBuffer('signal', message);
  }

  static debug(message: string, meta?: any): void {
    logger.debug(message, meta);
    // Don't buffer debug logs to avoid noise, or maybe optional?
    // this.addToBuffer('debug', message);
  }

  static trace(message: string, meta?: any): void {
    logger.log('trace', message, meta);
  }

  // Specialized trading event loggers
  static logSignal(signal: any): void {
    TradingLogger.signal(`Signal generated: ${signal.direction.toUpperCase()} ${signal.pair}`, {
      pair: signal.pair,
      direction: signal.direction,
      strength: signal.strength,
      components: signal.components,
      price: signal.price.toString(),
      timestamp: signal.timestamp
    });
  }

  static logTrade(order: any): void {
    TradingLogger.trade(`Trade executed: ${order.side.toUpperCase()} ${order.size} ${order.pair}`, {
      orderId: order.id,
      pair: order.pair,
      side: order.side,
      size: order.size.toString(),
      price: order.price?.toString(),
      type: order.type,
      status: order.status,
      timestamp: order.timestamp
    });
  }

  static logPosition(position: any): void {
    TradingLogger.trade(`Position opened: ${position.direction.toUpperCase()} ${position.size} ${position.pair}`, {
      pair: position.pair,
      direction: position.direction,
      size: position.size.toString(),
      entryPrice: position.entryPrice.toString(),
      stopLoss: position.stopLoss.toString(),
      signalId: position.signalId,
      timestamp: position.timestamp
    });
  }

  static logPnL(pnl: string, pair: string, direction: string): void {
    const pnlDecimal = parseFloat(pnl);
    if (pnlDecimal > 0) {
      TradingLogger.info(`PnL: +${pnl} USDC (${direction} ${pair})`, {
        pnl: pnl,
        pair: pair,
        direction: direction,
        profitable: true
      });
    } else {
      TradingLogger.warn(`PnL: ${pnl} USDC (${direction} ${pair})`, {
        pnl: pnl,
        pair: pair,
        direction: direction,
        profitable: false
      });
    }
  }

  static logError(error: Error, context?: string): void {
    TradingLogger.error(`${context || 'Error'}: ${error.message}`, {
      error: error.message,
      stack: error.stack,
      context: context
    });
  }

  static logApiCall(endpoint: string, method: string, success: boolean, duration?: number): void {
    if (success) {
      TradingLogger.debug(`API ${method} ${endpoint} - SUCCESS${duration ? ` (${duration}ms)` : ''}`, {
        endpoint,
        method,
        success,
        duration
      });
    } else {
      TradingLogger.warn(`API ${method} ${endpoint} - FAILED${duration ? ` (${duration}ms)` : ''}`, {
        endpoint,
        method,
        success,
        duration
      });
    }
  }
}
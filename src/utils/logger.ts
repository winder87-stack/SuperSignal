// Enhanced Logging utilities for comprehensive monitoring with data sanitization
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { statfs } from 'fs/promises';
import { LogMetadata } from '../types/hyperliquid.js';
import { TradingSignal, Position, Order } from '../types/index.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Sanitization level for sensitive data
 */
export enum SanitizationLevel {
  NONE = 'none',       // No sanitization (development only)
  PARTIAL = 'partial', // Mask sensitive fields (default)
  FULL = 'full'        // Redact all sensitive fields
}

/**
 * Error categories for structured error logging
 */
export enum ErrorCategory {
  NETWORK = 'network',
  API = 'api',
  VALIDATION = 'validation',
  EXECUTION = 'execution',
  STATE = 'state',
  RATE_LIMIT = 'rate_limit',
  TIMEOUT = 'timeout',
  UNKNOWN = 'unknown'
}

/**
 * Error codes for categorization and recovery
 */
export enum ErrorCode {
  // Network errors
  NETWORK_CONNECTION_FAILED = 'NET_001',
  NETWORK_TIMEOUT = 'NET_002',
  NETWORK_UNREACHABLE = 'NET_003',

  // API errors
  API_RATE_LIMIT = 'API_001',
  API_AUTH_FAILED = 'API_002',
  API_INVALID_RESPONSE = 'API_003',
  API_SERVER_ERROR = 'API_004',

  // Validation errors
  VALIDATION_INVALID_SIGNAL = 'VAL_001',
  VALIDATION_INVALID_ORDER = 'VAL_002',
  VALIDATION_INVALID_POSITION = 'VAL_003',

  // Execution errors
  EXEC_ORDER_FAILED = 'EXE_001',
  EXEC_SL_FAILED = 'EXE_002',
  EXEC_TP_FAILED = 'EXE_003',
  EXEC_CANCEL_FAILED = 'EXE_004',

  // State errors
  STATE_MISMATCH = 'STT_001',
  STATE_CORRUPTION = 'STT_002',
  STATE_RECOVERY_FAILED = 'STT_003',

  // Timeout errors
  TIMEOUT_ORDER_PLACEMENT = 'TMO_001',
  TIMEOUT_API_RESPONSE = 'TMO_002',
  TIMEOUT_WS_CONNECTION = 'TMO_003',

  // Unknown errors
  UNKNOWN_ERROR = 'UNK_001'
}

/**
 * Performance metrics for operation tracking
 */
export interface PerformanceMetrics {
  operation: string;
  duration: number;
  memoryUsage?: NodeJS.MemoryUsage;
  timestamp: number;
  metadata?: LogMetadata;
}

/**
 * Structured log context with tracing information
 */
export interface LogContext {
  requestId?: string;
  correlationId?: string;
  component?: string;
  module?: string;
  userId?: string;
  sessionId?: string;
}

/**
 * Enhanced error information with categorization
 */
export interface ErrorInfo {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  stack?: string;
  context?: string;
  operation?: string;
  recoverable: boolean;
  recoverySuggestion?: string;
  metadata?: LogMetadata;
}

/**
 * Logger configuration options
 */
export interface LoggerConfig {
  sanitizationLevel: SanitizationLevel;
  environment: 'development' | 'production' | 'test';
  logLevel: string;
  enablePerformanceLogging: boolean;
  enableRateLimiting: boolean;
  rateLimitWindow: number; // milliseconds
  rateLimitMaxLogs: number;
}

// ============================================================================
// SENSITIVE FIELD PATTERNS FOR SANITIZATION
// ============================================================================

const SENSITIVE_PATTERNS = [
  // Private keys (hex strings, 64+ chars)
  { pattern: /\b0x[a-fA-F0-9]{64,}\b/g, replacement: '0x***REDACTED***' },
  // API keys (alphanumeric, 32+ chars)
  { pattern: /\b[a-zA-Z0-9]{32,}\b/g, replacement: '***REDACTED***' },
  // Password-like fields
  { pattern: /"password":\s*"[^"]*"/gi, replacement: '"password": "***REDACTED***"' },
  { pattern: /"secret":\s*"[^"]*"/gi, replacement: '"secret": "***REDACTED***"' },
  { pattern: /"privateKey":\s*"[^"]*"/gi, replacement: '"privateKey": "***REDACTED***"' },
  { pattern: /"apiKey":\s*"[^"]*"/gi, replacement: '"apiKey": "***REDACTED***"' },
  { pattern: /"apiSecret":\s*"[^"]*"/gi, replacement: '"apiSecret": "***REDACTED***"' },
  // Signature components (r, s, v)
  { pattern: /"r":\s*"0x[a-fA-F0-9]{64}"/gi, replacement: '"r": "***REDACTED***"' },
  { pattern: /"s":\s*"0x[a-fA-F0-9]{64}"/gi, replacement: '"s": "***REDACTED***"' },
  // Connection IDs
  { pattern: /"connectionId":\s*"0x[a-fA-F0-9]{64}"/gi, replacement: '"connectionId": "***REDACTED***"' },
  // Nonce values (timestamps)
  { pattern: /"nonce":\s*\d{13,}/gi, replacement: '"nonce": ***REDACTED***' },
  // Order IDs (large numbers)
  { pattern: /"oid":\s*\d{10,}/gi, replacement: '"oid": ***REDACTED***' },
  // Transaction IDs
  { pattern: /"tid":\s*\d{10,}/gi, replacement: '"tid": ***REDACTED***' },
  // Hash values
  { pattern: /"hash":\s*"0x[a-fA-F0-9]{64}"/gi, replacement: '"hash": "***REDACTED***"' },
];

// Fields to redact in objects
const SENSITIVE_FIELDS = [
  'privateKey',
  'apiKey',
  'apiSecret',
  'secret',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'signature',
  'r',
  's',
  'v',
  'connectionId',
  'nonce',
  'oid',
  'tid',
  'hash',
];

// ============================================================================
// CUSTOM LOG LEVELS
// ============================================================================

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

// ============================================================================
// LOGGER CONFIGURATION
// ============================================================================

const logsDir = path.join(process.cwd(), 'logs');

const loggerConfig: LoggerConfig = {
  sanitizationLevel: process.env.LOG_SANITIZATION_LEVEL as SanitizationLevel || SanitizationLevel.PARTIAL,
  environment: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'trace'),
  enablePerformanceLogging: process.env.ENABLE_PERFORMANCE_LOGGING !== 'false',
  enableRateLimiting: true,
  rateLimitWindow: 60000, // 1 minute
  rateLimitMaxLogs: 100
};

// ============================================================================
// DISK SPACE MONITORING
// ============================================================================

let diskSpaceCritical = false;
let lastDiskCheck = 0;
const DISK_CHECK_INTERVAL = 60000; // Check every 60 seconds

/**
 * Check disk space and warn if running low
 * @returns true if disk space is critical (>95% used)
 */
async function checkDiskSpace(): Promise<boolean> {
  const now = Date.now();
  if (now - lastDiskCheck < DISK_CHECK_INTERVAL) {
    return diskSpaceCritical;
  }
  lastDiskCheck = now;

  try {
    const stats = await statfs(logsDir);
    const totalSpace = stats.blocks * stats.bsize;
    const freeSpace = stats.bfree * stats.bsize;
    const usedPercent = ((totalSpace - freeSpace) / totalSpace) * 100;

    if (usedPercent >= 95 && !diskSpaceCritical) {
      diskSpaceCritical = true;
      console.error(`CRITICAL: Disk space at ${usedPercent.toFixed(1)}%. Stopping file logging.`);
      logger.transports.forEach(transport => {
        if (transport instanceof DailyRotateFile) {
          transport.silent = true;
        }
      });
    } else if (usedPercent >= 90 && usedPercent < 95) {
      console.warn(`WARNING: Disk space at ${usedPercent.toFixed(1)}%. Consider cleaning up logs.`);
    } else if (usedPercent < 85 && diskSpaceCritical) {
      diskSpaceCritical = false;
      logger.transports.forEach(transport => {
        if (transport instanceof DailyRotateFile) {
          transport.silent = false;
        }
      });
      console.info('Disk space recovered. Re-enabling file logging.');
    }

    return diskSpaceCritical;
  } catch (error) {
    console.error('Failed to check disk space:', error);
    return false;
  }
}

// ============================================================================
// DATA SANITIZATION
// ============================================================================

/**
 * Sanitize a string value by replacing sensitive patterns
 */
function sanitizeString(value: string, level: SanitizationLevel): string {
  if (level === SanitizationLevel.NONE) {
    return value;
  }

  let sanitized = value;

  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

/**
 * Sanitize an object by redacting sensitive fields
 */
function sanitizeObject(obj: unknown, level: SanitizationLevel, depth = 0): unknown {
  if (level === SanitizationLevel.NONE) {
    return obj;
  }

  if (depth > 10) {
    return '[MAX_DEPTH_REACHED]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeString(obj, level);
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: sanitizeString(obj.message, level),
      stack: level === SanitizationLevel.FULL ? undefined : obj.stack
    };
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, level, depth + 1));
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_FIELDS.includes(key)) {
        if (level === SanitizationLevel.FULL) {
          sanitized[key] = '***REDACTED***';
        } else {
          // Partial: show first 4 and last 4 chars
          const strValue = String(value);
          if (strValue.length > 8) {
            sanitized[key] = `${strValue.substring(0, 4)}...${strValue.substring(strValue.length - 4)}`;
          } else {
            sanitized[key] = '***REDACTED***';
          }
        }
      } else {
        sanitized[key] = sanitizeObject(value, level, depth + 1);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Sanitize log metadata based on configured sanitization level
 */
export function sanitizeMetadata(meta: LogMetadata | Error | unknown): LogMetadata {
  const level = loggerConfig.sanitizationLevel;
  const sanitized = sanitizeObject(meta, level);
  return sanitized as LogMetadata;
}

// ============================================================================
// REQUEST ID GENERATION
// ============================================================================

/**
 * Generate a unique request ID for tracing
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Generate a correlation ID for async operation tracking
 */
export function generateCorrelationId(): string {
  return `corr_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// ============================================================================
// ERROR CATEGORIZATION
// ============================================================================

/**
 * Categorize an error and provide recovery suggestions
 */
export function categorizeError(error: Error | unknown, context?: string): ErrorInfo {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  // Network errors
  if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
    return {
      code: ErrorCode.NETWORK_CONNECTION_FAILED,
      category: ErrorCategory.NETWORK,
      message: errorMessage,
      stack: errorStack,
      context,
      recoverable: true,
      recoverySuggestion: 'Check network connectivity and retry',
      metadata: { originalError: errorMessage }
    };
  }

  if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
    return {
      code: ErrorCode.NETWORK_TIMEOUT,
      category: ErrorCategory.TIMEOUT,
      message: errorMessage,
      stack: errorStack,
      context,
      recoverable: true,
      recoverySuggestion: 'Increase timeout or retry with exponential backoff',
      metadata: { originalError: errorMessage }
    };
  }

  // API errors
  if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
    return {
      code: ErrorCode.API_RATE_LIMIT,
      category: ErrorCategory.RATE_LIMIT,
      message: errorMessage,
      stack: errorStack,
      context,
      recoverable: true,
      recoverySuggestion: 'Implement exponential backoff and reduce request rate',
      metadata: { originalError: errorMessage }
    };
  }

  if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('auth')) {
    return {
      code: ErrorCode.API_AUTH_FAILED,
      category: ErrorCategory.API,
      message: errorMessage,
      stack: errorStack,
      context,
      recoverable: false,
      recoverySuggestion: 'Check API credentials and permissions',
      metadata: { originalError: errorMessage }
    };
  }

  if (errorMessage.includes('500') || errorMessage.includes('502') || errorMessage.includes('503')) {
    return {
      code: ErrorCode.API_SERVER_ERROR,
      category: ErrorCategory.API,
      message: errorMessage,
      stack: errorStack,
      context,
      recoverable: true,
      recoverySuggestion: 'Server error - retry with backoff',
      metadata: { originalError: errorMessage }
    };
  }

  // Default: unknown error
  return {
    code: ErrorCode.UNKNOWN_ERROR,
    category: ErrorCategory.UNKNOWN,
    message: errorMessage,
    stack: errorStack,
    context,
    recoverable: false,
    recoverySuggestion: 'Investigate error details and logs',
    metadata: { originalError: errorMessage }
  };
}

// ============================================================================
// RATE LIMITING FOR LOGS
// ============================================================================

const logRateTracker = new Map<string, { count: number; resetTime: number }>();

/**
 * Check if a log message should be rate limited
 */
function shouldRateLimit(message: string): boolean {
  if (!loggerConfig.enableRateLimiting) {
    return false;
  }

  const now = Date.now();
  const key = message.substring(0, 100); // Use first 100 chars as key

  const tracker = logRateTracker.get(key);

  if (!tracker || now > tracker.resetTime) {
    logRateTracker.set(key, {
      count: 1,
      resetTime: now + loggerConfig.rateLimitWindow
    });
    return false;
  }

  if (tracker.count >= loggerConfig.rateLimitMaxLogs) {
    return true;
  }

  tracker.count++;
  return false;
}

// ============================================================================
// PERFORMANCE LOGGING
// ============================================================================

const performanceMetrics: PerformanceMetrics[] = [];
const MAX_PERFORMANCE_METRICS = 1000;

/**
 * Start a performance timer for an operation
 */
export function startPerformanceTimer(operation: string): () => PerformanceMetrics {
  const startTime = Date.now();

  return () => {
    const duration = Date.now() - startTime;
    const metrics: PerformanceMetrics = {
      operation,
      duration,
      memoryUsage: process.memoryUsage(),
      timestamp: Date.now()
    };

    // Store metrics
    performanceMetrics.push(metrics);
    if (performanceMetrics.length > MAX_PERFORMANCE_METRICS) {
      performanceMetrics.shift();
    }

    return metrics;
  };
}

/**
 * Get recent performance metrics
 */
export function getPerformanceMetrics(count: number = 50): PerformanceMetrics[] {
  return performanceMetrics.slice(-count);
}

/**
 * Get average duration for an operation
 */
export function getAverageOperationDuration(operation: string): number | null {
  const relevantMetrics = performanceMetrics.filter(m => m.operation === operation);
  if (relevantMetrics.length === 0) {
    return null;
  }
  const total = relevantMetrics.reduce((sum, m) => sum + m.duration, 0);
  return total / relevantMetrics.length;
}

// ============================================================================
// WINSTON LOGGER SETUP
// ============================================================================

const logger = winston.createLogger({
  levels: customLevels,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: 'hyperliquid-super-signal',
    environment: loggerConfig.environment
  },
  transports: [
    // Error log file with rotation
    new DailyRotateFile({
      filename: path.join(logsDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '100m',
      maxFiles: '7d',
      zippedArchive: true
    }),
    // Combined log file with rotation
    new DailyRotateFile({
      filename: path.join(logsDir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '100m',
      maxFiles: 10,
      zippedArchive: true
    }),
    // Performance log file with rotation
    new DailyRotateFile({
      filename: path.join(logsDir, 'performance-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '50m',
      maxFiles: '7d',
      zippedArchive: true
    }),
    // Console output for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}]: ${message}${metaStr}`;
        })
      ),
      level: loggerConfig.logLevel,
      stderrLevels: ['error', 'warn']
    })
  ]
});

// ============================================================================
// TRADING LOGGER CLASS
// ============================================================================

export class TradingLogger {
  private static recentLogs: Array<{ level: string; message: string; timestamp: number; context?: LogContext }> = [];
  private static MAX_LOGS = 50;
  private static currentRequestId?: string;
  private static currentCorrelationId?: string;
  private static currentComponent?: string;

  /**
   * Set the current request ID for tracing
   */
  static setRequestId(requestId: string): void {
    this.currentRequestId = requestId;
  }

  /**
   * Set the current correlation ID for async operations
   */
  static setCorrelationId(correlationId: string): void {
    this.currentCorrelationId = correlationId;
  }

  /**
   * Set the current component/module identifier
   */
  static setComponent(component: string): void {
    this.currentComponent = component;
  }

  /**
   * Get the current log context
   */
  private static getContext(): LogContext {
    return {
      requestId: this.currentRequestId,
      correlationId: this.currentCorrelationId,
      component: this.currentComponent
    };
  }

  /**
   * Add log to buffer
   */
  private static addToBuffer(level: string, message: string, context?: LogContext): void {
    this.recentLogs.unshift({
      level,
      message,
      timestamp: Date.now(),
      context
    });
    if (this.recentLogs.length > this.MAX_LOGS) {
      this.recentLogs.pop();
    }
  }

  /**
   * Get recent logs from buffer
   */
  static getRecentLogs(count: number = 20): Array<{ level: string; message: string; timestamp: number; context?: LogContext }> {
    return this.recentLogs.slice(0, count);
  }

  /**
   * Clear the log buffer
   */
  static clearBuffer(): void {
    this.recentLogs = [];
  }

  /**
   * Log an error message
   */
  static async error(message: string, meta?: LogMetadata | Error | unknown): Promise<void> {
    await checkDiskSpace();

    if (shouldRateLimit(message)) {
      return;
    }

    const context = this.getContext();
    const sanitizedMeta = sanitizeMetadata(meta);
    const logMeta = { ...sanitizedMeta, ...context };

    logger.error(message, logMeta);
    this.addToBuffer('error', message, context);
  }

  /**
   * Log a warning message
   */
  static async warn(message: string, meta?: LogMetadata): Promise<void> {
    await checkDiskSpace();

    if (shouldRateLimit(message)) {
      return;
    }

    const context = this.getContext();
    const sanitizedMeta = sanitizeMetadata(meta);
    const logMeta = { ...sanitizedMeta, ...context };

    logger.warn(message, logMeta);
    this.addToBuffer('warn', message, context);
  }

  /**
   * Log an info message
   */
  static async info(message: string, meta?: LogMetadata): Promise<void> {
    await checkDiskSpace();

    if (shouldRateLimit(message)) {
      return;
    }

    const context = this.getContext();
    const sanitizedMeta = sanitizeMetadata(meta);
    const logMeta = { ...sanitizedMeta, ...context };

    logger.info(message, logMeta);
    this.addToBuffer('info', message, context);
  }

  /**
   * Log a trade execution
   */
  static async trade(message: string, meta?: LogMetadata): Promise<void> {
    await checkDiskSpace();

    const context = this.getContext();
    const sanitizedMeta = sanitizeMetadata(meta);
    const logMeta = { ...sanitizedMeta, ...context };

    logger.log('trade', message, logMeta);
    this.addToBuffer('trade', message, context);
  }

  /**
   * Log a trading signal
   */
  static async signal(message: string, meta?: LogMetadata): Promise<void> {
    await checkDiskSpace();

    const context = this.getContext();
    const sanitizedMeta = sanitizeMetadata(meta);
    const logMeta = { ...sanitizedMeta, ...context };

    logger.log('signal', message, logMeta);
    this.addToBuffer('signal', message, context);
  }

  /**
   * Log a debug message
   */
  static debug(message: string, meta?: LogMetadata): void {
    const context = this.getContext();
    const sanitizedMeta = sanitizeMetadata(meta);
    const logMeta = { ...sanitizedMeta, ...context };

    logger.debug(message, logMeta);
  }

  /**
   * Log a trace message
   */
  static trace(message: string, meta?: LogMetadata): void {
    const context = this.getContext();
    const sanitizedMeta = sanitizeMetadata(meta);
    const logMeta = { ...sanitizedMeta, ...context };

    logger.log('trace', message, logMeta);
  }

  // ============================================================================
  // SPECIALIZED TRADING EVENT LOGGERS
  // ============================================================================

  /**
   * Log a trading signal with full context
   */
  static logSignal(signal: TradingSignal): void {
    const requestId = generateRequestId();
    this.setRequestId(requestId);

    this.signal(`Signal generated: ${signal.direction.toUpperCase()} ${signal.pair}`, {
      requestId,
      pair: signal.pair,
      direction: signal.direction,
      strength: signal.strength.toString(),
      price: signal.price.toString(),
      timestamp: signal.timestamp,
      components: signal.components
    });
  }

  /**
   * Log a trade execution with full context
   */
  static logTrade(order: Order): void {
    this.trade(`Trade executed: ${order.side.toUpperCase()} ${order.size} ${order.pair}`, {
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

  /**
   * Log a position with full context
   */
  static logPosition(position: Position): void {
    this.trade(`Position opened: ${position.direction.toUpperCase()} ${position.size} ${position.pair}`, {
      pair: position.pair,
      direction: position.direction,
      size: position.size.toString(),
      entryPrice: position.entryPrice.toString(),
      stopLoss: position.stopLoss.toString(),
      takeProfit: position.takeProfit?.toString(),
      signalId: position.signalId,
      timestamp: position.timestamp
    });
  }

  /**
   * Log PnL with context
   */
  static logPnL(pnl: string, pair: string, direction: string): void {
    const pnlDecimal = parseFloat(pnl);
    if (pnlDecimal > 0) {
      this.info(`PnL: +${pnl} USDC (${direction} ${pair})`, {
        pnl: pnl,
        pair: pair,
        direction: direction,
        profitable: true
      });
    } else {
      this.warn(`PnL: ${pnl} USDC (${direction} ${pair})`, {
        pnl: pnl,
        pair: pair,
        direction: direction,
        profitable: false
      });
    }
  }

  /**
   * Log an error with categorization and recovery suggestions
   */
  static logError(error: Error | unknown, context?: string): void {
    const errorInfo = categorizeError(error, context);
    this.error(`${context || 'Error'}: ${errorInfo.message}`, {
      errorCode: errorInfo.code,
      errorCategory: errorInfo.category,
      recoverable: errorInfo.recoverable,
      recoverySuggestion: errorInfo.recoverySuggestion,
      stack: errorInfo.stack,
      context: context,
      ...errorInfo.metadata
    });
  }

  /**
   * Log an API call with performance tracking
   */
  static logApiCall(endpoint: string, method: string, success: boolean, duration?: number): void {
    const endTimer = startPerformanceTimer(`API_${method}_${endpoint}`);
    const metrics = endTimer();

    if (success) {
      this.debug(`API ${method} ${endpoint} - SUCCESS (${duration || metrics.duration}ms)`, {
        endpoint,
        method,
        success,
        duration: duration || metrics.duration
      });
    } else {
      this.warn(`API ${method} ${endpoint} - FAILED (${duration || metrics.duration}ms)`, {
        endpoint,
        method,
        success,
        duration: duration || metrics.duration
      });
    }

    // Log performance metrics separately
    if (loggerConfig.enablePerformanceLogging) {
      logger.log('debug', `Performance: ${metrics.operation}`, {
        duration: metrics.duration,
        memoryUsage: metrics.memoryUsage,
        timestamp: metrics.timestamp
      });
    }
  }

  /**
   * Log performance metrics for an operation
   */
  static logPerformance(operation: string, duration: number, metadata?: LogMetadata): void {
    if (!loggerConfig.enablePerformanceLogging) {
      return;
    }

    const metrics: PerformanceMetrics = {
      operation,
      duration,
      memoryUsage: process.memoryUsage(),
      timestamp: Date.now(),
      metadata
    };

    performanceMetrics.push(metrics);
    if (performanceMetrics.length > MAX_PERFORMANCE_METRICS) {
      performanceMetrics.shift();
    }

    logger.log('debug', `Performance: ${operation}`, {
      duration: metrics.duration,
      memoryUsage: metrics.memoryUsage,
      timestamp: metrics.timestamp,
      ...metadata
    });
  }

  /**
   * Log a WebSocket event
   */
  static logWebSocketEvent(event: string, data?: unknown): void {
    this.debug(`WebSocket: ${event}`, {
      event,
      data: data ? sanitizeMetadata(data as LogMetadata) : undefined,
      timestamp: Date.now()
    });
  }

  /**
   * Log a state change
   */
  static logStateChange(component: string, state: string, details?: LogMetadata): void {
    this.info(`State change: ${component} -> ${state}`, {
      component,
      state,
      ...details
    });
  }

  /**
   * Log a risk management event
   */
  static logRiskEvent(event: string, details: LogMetadata): void {
    this.warn(`Risk: ${event}`, details);
  }

  /**
   * Log a database operation
   */
  static logDatabaseOperation(operation: string, table: string, success: boolean, duration?: number): void {
    if (success) {
      this.debug(`DB: ${operation} on ${table} (${duration || 0}ms)`, {
        operation,
        table,
        success,
        duration
      });
    } else {
      this.error(`DB: ${operation} on ${table} FAILED`, {
        operation,
        table,
        success,
        duration
      });
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { logger as winstonLogger };
export { loggerConfig };
export { customLevels, colors };

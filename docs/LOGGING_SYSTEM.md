# Logging System Documentation

## Overview

The Hyperliquid Super Signal trading bot uses a comprehensive, production-grade logging system built on Winston with advanced features for 7-day endurance testing and production monitoring.

## Table of Contents

- [Features](#features)
- [Configuration](#configuration)
- [Log Levels](#log-levels)
- [Data Sanitization](#data-sanitization)
- [Structured Context](#structured-context)
- [Error Categorization](#error-categorization)
- [Performance Logging](#performance-logging)
- [Usage Examples](#usage-examples)
- [Best Practices](#best-practices)

---

## Features

### 1. **Data Sanitization**

- Automatic redaction of sensitive fields (API keys, private keys, tokens)
- Configurable sanitization levels (NONE, PARTIAL, FULL)
- Pattern-based masking for common sensitive data formats

### 2. **Structured Context**

- Request IDs for distributed tracing
- Correlation IDs for async operation tracking
- Component/module identifiers
- User/session context

### 3. **Error Categorization**

- Automatic error categorization with codes
- Recovery suggestions for common errors
- Error context and operation tracking

### 4. **Performance Logging**

- Operation timing with automatic tracking
- Memory usage monitoring
- Performance metrics aggregation
- Average duration calculations

### 5. **Log Rotation**

- Daily log file rotation
- Automatic compression (gzip)
- Configurable retention periods
- Disk space monitoring with automatic throttling

### 6. **Rate Limiting**

- Per-message rate limiting to prevent log spam
- Configurable windows and thresholds
- Automatic suppression of repetitive logs

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|-----------|---------|-------------|
| `LOG_LEVEL` | `info` (production) / `trace` (development) | Minimum log level to output |
| `LOG_SANITIZATION_LEVEL` | `partial` | Data sanitization level (`none`, `partial`, `full`) |
| `ENABLE_PERFORMANCE_LOGGING` | `true` | Enable performance metrics collection |
| `NODE_ENV` | `development` | Environment mode (`development`, `production`, `test`) |

### Programmatic Configuration

```typescript
import { loggerConfig, SanitizationLevel } from './utils/logger.js';

// Update configuration at runtime
loggerConfig.sanitizationLevel = SanitizationLevel.FULL;
loggerConfig.logLevel = 'debug';
loggerConfig.enablePerformanceLogging = true;
```

---

## Log Levels

The logging system uses custom levels tailored for trading applications:

| Level | Priority | Use Case |
|--------|-----------|------------|
| `error` | 0 | Critical errors requiring immediate attention |
| `warn` | 1 | Warning conditions that don't prevent operation |
| `info` | 2 | General informational messages |
| `trade` | 3 | Trade executions and position changes |
| `signal` | 4 | Trading signal generation |
| `debug` | 5 | Detailed debugging information |
| `trace` | 6 | Very detailed tracing information |

### Level Filtering

Logs are filtered based on environment:

- **Development**: All levels (`trace` and above)
- **Production**: `info` and above (excludes `debug` and `trace`)
- **Test**: `warn` and above

---

## Data Sanitization

### Sanitization Levels

#### `SanitizationLevel.NONE`

No sanitization applied. Use only in development environments with trusted access.

#### `SanitizationLevel.PARTIAL` (Default)

Sensitive fields are partially masked:

- Private keys: `0x1234...abcd` (first 4 and last 4 chars)
- API keys: `abcd...wxyz`
- Tokens: `***REDACTED***`

#### `SanitizationLevel.FULL`

All sensitive fields are completely redacted:

- All sensitive fields replaced with `***REDACTED***`
- Stack traces omitted from error logs

### Sensitive Fields

The following fields are automatically sanitized:

| Field Pattern | Example | Sanitized Output |
|---------------|---------|------------------|
| `privateKey` | `0x1234...` | `***REDACTED***` |
| `apiKey` | `sk_live_...` | `***REDACTED***` |
| `apiSecret` | `secret_...` | `***REDACTED***` |
| `signature.r` | `0xabc...` | `***REDACTED***` |
| `signature.s` | `0xdef...` | `***REDACTED***` |
| `nonce` | `1234567890` | `***REDACTED***` |
| `oid` (Order ID) | `1234567890` | `***REDACTED***` |
| `tid` (Transaction ID) | `1234567890` | `***REDACTED***` |
| `hash` | `0xabc...` | `***REDACTED***` |

### Custom Sanitization

```typescript
import { sanitizeMetadata } from './utils/logger.js';

// Sanitize any object before logging
const sanitized = sanitizeMetadata({
  apiKey: 'sk_live_1234567890',
  userId: 'user123'
});

// Output: { apiKey: '***REDACTED***', userId: 'user123' }
```

---

## Structured Context

### Request IDs

Request IDs enable tracing of operations across async boundaries:

```typescript
import { generateRequestId, TradingLogger } from './utils/logger.js';

const requestId = generateRequestId();
TradingLogger.setRequestId(requestId);

// All subsequent logs will include this requestId
TradingLogger.info('Processing order', { orderId: '123' });
```

### Correlation IDs

Correlation IDs track related operations across multiple components:

```typescript
import { generateCorrelationId, TradingLogger } from './utils/logger.js';

const correlationId = generateCorrelationId();
TradingLogger.setCorrelationId(correlationId);

// All logs in this operation flow share the correlationId
```

### Component Tracking

Set the component identifier for better log organization:

```typescript
import { TradingLogger } from './utils/logger.js';

TradingLogger.setComponent('TradingEngine');

// All logs will include component: 'TradingEngine'
TradingLogger.info('Processing signal');
```

### Context Object

The `LogContext` interface provides structured context:

```typescript
interface LogContext {
  requestId?: string;      // Unique request identifier
  correlationId?: string;  // Links related operations
  component?: string;       // Component/module name
  module?: string;          // Module identifier
  userId?: string;         // User identifier
  sessionId?: string;       // Session identifier
}
```

---

## Error Categorization

### Error Categories

| Category | Code | Description |
|-----------|-------|-------------|
| `NETWORK` | `NET_*` | Network connectivity issues |
| `API` | `API_*` | API request/response errors |
| `VALIDATION` | `VAL_*` | Input validation failures |
| `EXECUTION` | `EXE_*` | Order execution failures |
| `STATE` | `STT_*` | State management issues |
| `RATE_LIMIT` | `API_001` | Rate limiting |
| `TIMEOUT` | `TMO_*` | Timeout errors |
| `UNKNOWN` | `UNK_*` | Unclassified errors |

### Error Codes

```typescript
import { ErrorCode, ErrorCategory } from './utils/logger.js';

// Network errors
ErrorCode.NETWORK_CONNECTION_FAILED  // Connection refused/unreachable
ErrorCode.NETWORK_TIMEOUT          // Request timeout
ErrorCode.NETWORK_UNREACHABLE     // DNS/host resolution failed

// API errors
ErrorCode.API_RATE_LIMIT          // 429 Too Many Requests
ErrorCode.API_AUTH_FAILED         // 401/403 Authentication failed
ErrorCode.API_SERVER_ERROR        // 500/502/503 Server errors

// Execution errors
ErrorCode.EXEC_ORDER_FAILED       // Order placement failed
ErrorCode.EXEC_SL_FAILED          // Stop loss placement failed
ErrorCode.EXEC_TP_FAILED          // Take profit placement failed
```

### Error Logging with Categorization

```typescript
import { TradingLogger } from './utils/logger.js';

try {
  await someOperation();
} catch (error) {
  // Automatic categorization with recovery suggestions
  TradingLogger.logError(error, 'Operation failed');
}
```

### Manual Error Categorization

```typescript
import { categorizeError, ErrorCode, ErrorCategory } from './utils/logger.js';

const errorInfo = categorizeError(error, 'Context string');

console.log(errorInfo.code);           // 'NET_001'
console.log(errorInfo.category);       // ErrorCategory.NETWORK
console.log(errorInfo.recoverable);    // true/false
console.log(errorInfo.recoverySuggestion); // 'Check network connectivity'
```

---

## Performance Logging

### Operation Timing

```typescript
import { startPerformanceTimer, TradingLogger } from './utils/logger.js';

const endTimer = startPerformanceTimer('operationName');

// ... perform operation ...

const metrics = endTimer();
// metrics = { operation: 'operationName', duration: 123, timestamp: ... }

// Automatically logged to performance log file
```

### Performance Metrics

```typescript
import { getPerformanceMetrics, getAverageOperationDuration } from './utils/logger.js';

// Get recent performance metrics
const metrics = getPerformanceMetrics(50);

// Get average duration for specific operation
const avgDuration = getAverageOperationDuration('placeOrder');
```

### Performance Log Format

```json
{
  "level": "debug",
  "message": "Performance: placeOrder",
  "timestamp": "2026-01-04 18:00:00.000",
  "duration": 123,
  "memoryUsage": {
    "rss": 123456789,
    "heapTotal": 987654321,
    "heapUsed": 123456789
  },
  "operation": "placeOrder"
}
```

---

## Usage Examples

### Basic Logging

```typescript
import { TradingLogger } from './utils/logger.js';

// Info level
TradingLogger.info('Bot started', { pairs: ['BTC', 'ETH'] });

// Warning level
TradingLogger.warn('High latency detected', { latency: 500 });

// Error level
TradingLogger.error('Connection failed', { endpoint: 'api.example.com' });

// Debug level
TradingLogger.debug('Processing candle', { pair: 'BTC', close: 50000 });
```

### Trading-Specific Logging

```typescript
import { TradingLogger } from './utils/logger.js';

// Log trading signal
TradingLogger.logSignal({
  pair: 'BTC-USDC',
  direction: 'long',
  strength: 0.85,
  price: new Decimal('50000'),
  timestamp: Date.now(),
  components: { /* ... */ }
});

// Log trade execution
TradingLogger.logTrade({
  id: 'order-123',
  pair: 'BTC-USDC',
  side: 'buy',
  size: new Decimal('0.1'),
  price: new Decimal('50000'),
  type: 'limit',
  status: 'filled',
  timestamp: Date.now()
});

// Log position
TradingLogger.logPosition({
  pair: 'BTC-USDC',
  direction: 'long',
  size: new Decimal('0.1'),
  entryPrice: new Decimal('50000'),
  stopLoss: new Decimal('49000'),
  signalId: 'signal-123',
  timestamp: Date.now()
});

// Log PnL
TradingLogger.logPnL('150.50', 'BTC-USDC', 'long');
```

### API Call Logging

```typescript
import { TradingLogger } from './utils/logger.js';

// Log API call with performance tracking
TradingLogger.logApiCall(
  '/exchange',
  'POST',
  true,  // success
  123    // duration in ms
);
```

### WebSocket Event Logging

```typescript
import { TradingLogger } from './utils/logger.js';

// Log WebSocket events
TradingLogger.logWebSocketEvent('connected', { url: 'wss://api.example.com' });
TradingLogger.logWebSocketEvent('message', { channel: 'l2Book', data: { /* ... */ } });
TradingLogger.logWebSocketEvent('disconnected', { code: 1000, reason: 'Normal closure' });
```

### State Change Logging

```typescript
import { TradingLogger } from './utils/logger.js';

// Log state transitions
TradingLogger.logStateChange('TradingEngine', 'RUNNING', { uptime: 3600 });
TradingLogger.logStateChange('RiskManager', 'HALTED', { reason: 'Daily loss limit reached' });
```

### Risk Event Logging

```typescript
import { TradingLogger } from './utils/logger.js';

// Log risk management events
TradingLogger.logRiskEvent('Position size limit reached', {
  currentSize: 10000,
  maxSize: 10000,
  pair: 'BTC-USDC'
});
```

### Database Operation Logging

```typescript
import { TradingLogger } from './utils/logger.js';

// Log database operations
TradingLogger.logDatabaseOperation(
  'insert',
  'trades',
  true,   // success
  45       // duration in ms
);
```

### Getting Recent Logs

```typescript
import { TradingLogger } from './utils/logger.js';

// Get recent logs from buffer
const recentLogs = TradingLogger.getRecentLogs(20);

// Each log entry:
// {
//   level: 'info',
//   message: 'Bot started',
//   timestamp: 1704371200000,
//   context: { requestId: 'req_...', component: 'TradingBot' }
// }
```

---

## Best Practices

### 1. **Use Appropriate Log Levels**

- **Error**: Only for critical failures that prevent operation
- **Warn**: For issues that don't stop operation but need attention
- **Info**: For normal operational events (startups, shutdowns, trades)
- **Trade**: For all trading-related events (signals, orders, positions)
- **Debug**: For detailed troubleshooting information
- **Trace**: For very detailed execution flow (use sparingly)

### 2. **Include Context**

Always provide relevant context with log messages:

```typescript
// Good
TradingLogger.info('Order placed', {
  orderId: '123',
  pair: 'BTC-USDC',
  side: 'buy',
  size: '0.1',
  price: '50000'
});

// Avoid
TradingLogger.info('Order placed');
```

### 3. **Use Structured Data**

Use objects instead of string concatenation:

```typescript
// Good
TradingLogger.info('Position opened', {
  pair: 'BTC-USDC',
  direction: 'long',
  size: '0.1',
  entryPrice: '50000'
});

// Avoid
TradingLogger.info(`Position opened: BTC-USDC long 0.1 @ 50000`);
```

### 4. **Set Request IDs for Tracing**

For operations that span multiple async calls:

```typescript
const requestId = generateRequestId();
TradingLogger.setRequestId(requestId);

await step1();
await step2();
await step3();

// All logs will have the same requestId for correlation
```

### 5. **Use Specialized Loggers**

Use domain-specific loggers when available:

```typescript
// Use specialized loggers for trading events
TradingLogger.logSignal(signal);
TradingLogger.logTrade(order);
TradingLogger.logPosition(position);
TradingLogger.logPnL(pnl, pair, direction);

// Use error categorization
TradingLogger.logError(error, 'Operation context');

// Use performance tracking
const endTimer = startPerformanceTimer('operationName');
// ... operation ...
endTimer();
```

### 6. **Avoid Logging Sensitive Data**

The sanitization system handles most cases, but be mindful:

```typescript
// Avoid logging raw credentials
TradingLogger.info('API call', { apiKey: 'sk_live_...' });  // BAD

// Use sanitized versions or omit
TradingLogger.info('API call', { endpoint: '/exchange' });  // GOOD
```

### 7. **Performance Considerations**

- Log rate limiting prevents log spam during high-frequency operations
- Disk space monitoring prevents disk exhaustion during 7-day runs
- Log rotation keeps disk usage manageable
- Performance logging has minimal overhead (<1ms per operation)

### 8. **7-Day Endurance Test Preparation**

For extended test runs:

1. **Monitor disk space**: Logs are rotated and compressed automatically
2. **Check performance metrics**: Use `getPerformanceMetrics()` to identify bottlenecks
3. **Review error patterns**: Categorized errors help identify recurring issues
4. **Use request IDs**: Essential for tracing complex async flows
5. **Enable appropriate log level**: `info` for production, `debug` for troubleshooting

---

## Log Files

### File Locations

Logs are stored in the `logs/` directory:

| File | Content | Retention |
|-------|---------|------------|
| `error-YYYY-MM-DD.log` | Error-level logs only | 7 days |
| `combined-YYYY-MM-DD.log` | All log levels | 10 files |
| `performance-YYYY-MM-DD.log` | Performance metrics | 7 days |

### Log Format

All log files use JSON format for machine parsing:

```json
{
  "level": "info",
  "message": "Bot started",
  "timestamp": "2026-01-04 18:00:00.000",
  "service": "hyperliquid-super-signal",
  "environment": "production",
  "requestId": "req_1704371200000_abc123",
  "component": "TradingBot",
  "pair": "BTC-USDC",
  "direction": "long"
}
```

---

## Troubleshooting

### Logs Not Appearing

1. Check `LOG_LEVEL` environment variable
2. Verify disk space (logs are disabled at 95% usage)
3. Check file permissions on `logs/` directory

### Too Many Logs

1. Adjust `LOG_LEVEL` to filter verbose messages
2. Check for repetitive error patterns
3. Review rate limiting configuration

### Performance Issues

1. Review performance metrics: `getPerformanceMetrics()`
2. Check for long-running operations
3. Identify memory leaks in performance data

### Sensitive Data Leaking

1. Verify `LOG_SANITIZATION_LEVEL` is set to `partial` or `full`
2. Check for custom log calls bypassing sanitization
3. Review error logs that may include stack traces

---

## API Reference

### TradingLogger Class

#### Static Methods

| Method | Description |
|---------|-------------|
| `error(message, meta?)` | Log error message |
| `warn(message, meta?)` | Log warning message |
| `info(message, meta?)` | Log info message |
| `trade(message, meta?)` | Log trade event |
| `signal(message, meta?)` | Log signal event |
| `debug(message, meta?)` | Log debug message |
| `trace(message, meta?)` | Log trace message |
| `logSignal(signal)` | Log trading signal with context |
| `logTrade(order)` | Log trade execution |
| `logPosition(position)` | Log position opening |
| `logPnL(pnl, pair, direction)` | Log profit/loss |
| `logError(error, context?)` | Log error with categorization |
| `logApiCall(endpoint, method, success, duration?)` | Log API call |
| `logWebSocketEvent(event, data?)` | Log WebSocket event |
| `logStateChange(component, state, details?)` | Log state transition |
| `logRiskEvent(event, details)` | Log risk management event |
| `logDatabaseOperation(operation, table, success, duration?)` | Log DB operation |
| `logPerformance(operation, duration, metadata?)` | Log performance metric |

#### Context Methods

| Method | Description |
|---------|-------------|
| `setRequestId(requestId)` | Set request ID for tracing |
| `setCorrelationId(correlationId)` | Set correlation ID for async operations |
| `setComponent(component)` | Set component identifier |
| `getRecentLogs(count?)` | Get recent logs from buffer |
| `clearBuffer()` | Clear recent logs buffer |

#### Utility Functions

| Function | Description |
|----------|-------------|
| `generateRequestId()` | Generate unique request ID |
| `generateCorrelationId()` | Generate unique correlation ID |
| `sanitizeMetadata(meta)` | Sanitize log metadata |
| `categorizeError(error, context?)` | Categorize error with recovery suggestions |
| `startPerformanceTimer(operation)` | Start performance timer |
| `getPerformanceMetrics(count?)` | Get recent performance metrics |
| `getAverageOperationDuration(operation)` | Get average duration for operation |

---

## Migration Guide

### From Old Logger

If you have existing code using the old logger:

```typescript
// Old way
logger.info('Message', { data: value });

// New way - same interface, enhanced features
TradingLogger.info('Message', { data: value });
```

### Adding Context to Existing Code

```typescript
// Before
async function processOrder(order: Order) {
  logger.info('Processing order');
  await api.placeOrder(order);
}

// After
async function processOrder(order: Order) {
  const requestId = generateRequestId();
  TradingLogger.setRequestId(requestId);
  TradingLogger.setComponent('OrderProcessor');
  
  TradingLogger.info('Processing order', { orderId: order.id });
  
  const endTimer = startPerformanceTimer('placeOrder');
  await api.placeOrder(order);
  endTimer();
}
```

---

## Support

For issues or questions about the logging system:

1. Check this documentation first
2. Review log files for error patterns
3. Use `getRecentLogs()` for in-memory log inspection
4. Monitor performance metrics for bottlenecks

---

## Version History

- **v2.0** (2026-01-04): Complete rewrite with sanitization, categorization, performance logging
- **v1.0**: Initial Winston-based implementation

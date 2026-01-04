# Endurance Test Guide

## Overview

This guide provides comprehensive instructions for running endurance tests to validate the 7-day endurance test preparation. The endurance test suite validates system stability, performance, and resource management under extended operation.

## Table of Contents

- [Test Execution Instructions](#test-execution-instructions)
- [Expected Results](#expected-results)
- [Troubleshooting Guide](#troubleshooting-guide)
- [Performance Benchmarks](#performance-benchmarks)

---

## Test Execution Instructions

### Prerequisites

Before running endurance tests, ensure:

1. **Node.js Version**: Node.js 18+ is required
2. **Dependencies**: All project dependencies are installed (`npm install`)
3. **Environment Variables**: Required environment variables are set (see `.env.example`)
4. **Disk Space**: At least 1GB free space for test databases and logs
5. **Memory**: At least 2GB RAM available

### Running Tests

#### Quick Test (1 Hour Equivalent)

Run a quick endurance test for rapid validation:

```bash
# Run all endurance tests with 1-hour duration
npm test -- tests/endurance/endurance-validation.test.ts

# Or run specific scenario
npm test -- tests/endurance/scenarios/websocket-reconnection.ts
npm test -- tests/endurance/scenarios/database-batch-sync.ts
npm test -- tests/endurance/scenarios/high-frequency-trading.ts
npm test -- tests/endurance/scenarios/graceful-shutdown.ts
npm test -- tests/endurance/scenarios/error-recovery.ts
```

#### Standard Test (24 Hours Equivalent)

Run a standard endurance test for comprehensive validation:

```bash
# Run all endurance tests with 24-hour duration
npm test -- tests/endurance/endurance-validation.test.ts -- --testTimeout=86400000
```

#### Full Test (7 Days)

Run the full 7-day endurance test:

```bash
# Run all endurance tests with 7-day duration
npm test -- tests/endurance/endurance-validation.test.ts -- --testTimeout=604800000
```

#### Custom Duration

Run tests with a custom duration:

```bash
# Run with custom duration (in milliseconds)
npm test -- tests/endurance/endurance-validation.test.ts -- --testTimeout=3600000
```

### Test Scenarios

The endurance test suite includes the following scenarios:

#### 1. WebSocket Reconnection Scenario

**File**: `tests/endurance/scenarios/websocket-reconnection.ts`

**Tests**:

- Connection drop and reconnection
- Exponential backoff for reconnection
- Subscription restoration after reconnection
- Message buffering during reconnection
- Pong timeout detection
- Memory leak prevention
- Event listener cleanup

**Duration**: ~30 seconds

**Expected Behavior**:

- WebSocket should reconnect after disconnection
- Subscriptions should be restored
- Buffered messages should be processed
- No memory leaks should be detected

#### 2. Database Batch Sync Scenario

**File**: `tests/endurance/scenarios/database-batch-sync.ts`

**Tests**:

- High-frequency batch writes
- Batch flush on size threshold
- Batch flush on time interval
- WAL mode performance
- Concurrent reads and writes
- Transaction error handling
- Connection state tracking
- Memory leak prevention
- Batch file persistence
- Equity snapshot operations
- Error recovery

**Duration**: ~30 seconds

**Expected Behavior**:

- Database should handle high-frequency writes
- WAL mode should be enabled
- Batch files should be persisted
- No memory leaks should be detected

#### 3. High-Frequency Trading Scenario

**File**: `tests/endurance/scenarios/high-frequency-trading.ts`

**Tests**:

- Rapid candle processing
- Indicator calculation performance
- Order placement throughput
- Memory stability under load
- CPU usage under load
- Error handling under load
- Concurrent operations

**Duration**: ~30 seconds

**Expected Behavior**:

- System should handle high-frequency operations
- Event loop should remain responsive
- Memory should remain stable
- CPU usage should be reasonable

#### 4. Graceful Shutdown Scenario

**File**: `tests/endurance/scenarios/graceful-shutdown.ts`

**Tests**:

- Interval cleanup on shutdown
- Database connection closure
- WebSocket disconnection
- Resource release
- Memory cleanup
- Error handling during shutdown

**Duration**: ~20 seconds

**Expected Behavior**:

- All intervals should be cleared
- Database should close gracefully
- WebSocket should disconnect cleanly
- No memory leaks should remain

#### 5. Error Recovery Scenario

**File**: `tests/endurance/scenarios/error-recovery.ts`

**Tests**:

- Interval callback error handling
- Database write error handling
- Transient error recovery
- Graceful degradation under high error rate
- System stability after error bursts
- Memory stability after errors
- Promise rejection handling

**Duration**: ~25 seconds

**Expected Behavior**:

- Errors should be caught and logged
- System should recover from transient errors
- No memory leaks should occur
- System should remain stable

### Using the Test Runner

The test runner (`tests/endurance/runner.ts`) provides a configurable way to run endurance tests:

```typescript
import { EnduranceTestRunner, createTestConfig } from './tests/endurance/runner.js';

// Create test configuration
const config = createTestConfig(
    'My Endurance Test',
    '1h', // Duration: '1h' | '24h' | '7d'
    [
        {
            name: 'WebSocket Reconnection',
            run: async (monitor) => {
                // Your test logic here
            }
        },
        {
            name: 'Database Operations',
            run: async (monitor) => {
                // Your test logic here
            }
        }
    ],
    undefined, // customDurationMs (optional)
    {
        maxMemoryGrowthRate: 1024 * 1024, // 1 MB/s
        maxEventLoopLag: 100, // 100ms
        maxCpuUsage: 80, // 80%
        maxMemoryUsage: 1024 * 1024 * 1024 // 1 GB
    }
);

// Run the test
const runner = new EnduranceTestRunner(config);
const report = await runner.run();

console.log('Test Report:', report);
```

---

## Expected Results

### Test Report Structure

Each test run generates a comprehensive report with the following structure:

```typescript
{
    testName: string;
    duration: '1h' | '24h' | '7d';
    customDuration?: number;
    startTime: number;
    endTime: number;
    totalDuration: number;
    results: TestResult[];
    summary: {
        totalTests: number;
        passedTests: number;
        failedTests: number;
        passRate: number;
    };
    overallMetrics: {
        memory: {
            avgGrowthRate: number;
            maxGrowthRate: number;
        };
        cpu: {
            avgUsage: number;
            maxUsage: number;
        };
        eventLoop: {
            avgLag: number;
            maxLag: number;
        };
    };
    recommendations: string[];
}
```

### Success Criteria

A test is considered successful if:

1. **All Tests Pass**: All individual test scenarios pass
2. **No Memory Leaks**: Memory growth rate is below threshold (1 MB/s)
3. **Event Loop Responsive**: Event loop lag is below threshold (100ms)
4. **CPU Usage Reasonable**: CPU usage is below threshold (80%)
5. **No Resource Leaks**: All intervals, timers, and listeners are cleaned up

### Expected Metrics

#### Memory Metrics

| Metric | Expected Value | Threshold |
|--------|---------------|------------|
| Memory Growth Rate | < 1 MB/s | 1 MB/s |
| Max Memory Usage | < 1 GB | 1 GB |
| Memory After Cleanup | < 5 MB growth | N/A |

#### CPU Metrics

| Metric | Expected Value | Threshold |
|--------|---------------|------------|
| Average CPU Usage | < 50% | 80% |
| Max CPU Usage | < 100% | 100% |

#### Event Loop Metrics

| Metric | Expected Value | Threshold |
|--------|---------------|------------|
| Average Event Loop Lag | < 10ms | 100ms |
| Max Event Loop Lag | < 50ms | 200ms |

#### Database Metrics

| Metric | Expected Value | Threshold |
|--------|---------------|------------|
| Write Throughput | > 100 writes/s | N/A |
| Batch Flush Time | < 100ms | N/A |
| WAL Mode | Enabled | N/A |

#### WebSocket Metrics

| Metric | Expected Value | Threshold |
|--------|---------------|------------|
| Reconnection Time | < 30s | N/A |
| Subscription Restoration | Successful | N/A |
| Message Buffering | Functional | N/A |

---

## Troubleshooting Guide

### Common Issues and Solutions

#### Issue: Tests Timeout

**Symptoms**:

- Tests fail with timeout error
- Tests take longer than expected

**Solutions**:

1. Increase test timeout: `npm test -- --testTimeout=300000`
2. Check system resources (CPU, memory)
3. Close other applications consuming resources
4. Run tests on a more powerful machine

#### Issue: Memory Leaks Detected

**Symptoms**:

- Memory growth rate exceeds threshold
- Memory usage continuously increases

**Solutions**:

1. Check for unclosed intervals: Review interval creation and cleanup
2. Check for unclosed timers: Review setTimeout/setInterval usage
3. Check for event listeners: Review event listener removal
4. Check for closures: Review closure references
5. Run with `--expose-gc` flag: `node --expose-gc node_modules/.bin/vitest`

#### Issue: High Event Loop Lag

**Symptoms**:

- Event loop lag exceeds threshold
- System appears unresponsive

**Solutions**:

1. Check for blocking operations: Review synchronous code
2. Check for heavy computations: Offload to worker threads
3. Check for I/O operations: Use async/await properly
4. Check for large loops: Break into smaller chunks

#### Issue: High CPU Usage

**Symptoms**:

- CPU usage exceeds threshold
- System becomes slow

**Solutions**:

1. Check for inefficient algorithms: Optimize code
2. Check for unnecessary computations: Remove redundant work
3. Check for polling: Use event-driven approach
4. Check for tight loops: Add delays or use intervals

#### Issue: Database Errors

**Symptoms**:

- Database write errors
- Batch flush failures

**Solutions**:

1. Check disk space: Ensure sufficient space
2. Check file permissions: Ensure write access
3. Check database locks: Close connections properly
4. Check WAL mode: Verify WAL is enabled

#### Issue: WebSocket Connection Failures

**Symptoms**:

- WebSocket fails to connect
- Reconnection attempts fail

**Solutions**:

1. Check network connectivity: Verify internet connection
2. Check firewall settings: Allow WebSocket connections
3. Check server status: Verify HyperLiquid server is up
4. Check authentication: Verify API credentials

### Debug Mode

Enable debug mode for detailed logging:

```bash
# Set log level to debug
export LOG_LEVEL=debug

# Run tests with debug output
npm test -- tests/endurance/endurance-validation.test.ts
```

### Memory Profiling

Profile memory usage during tests:

```bash
# Run with Node.js memory profiling
node --inspect --heap-prof tests/endurance/runner.js

# Generate heap snapshot
node --heap-prof tests/endurance/runner.js
```

### CPU Profiling

Profile CPU usage during tests:

```bash
# Run with Node.js CPU profiling
node --prof tests/endurance/runner.js

# Generate CPU profile
node --prof-process tests/endurance/runner.js
```

---

## Performance Benchmarks

### Baseline Performance

The following benchmarks represent expected performance on a typical development machine:

| Operation | Baseline | Acceptable Range |
|-----------|-----------|-----------------|
| Interval Creation | < 1ms | < 5ms |
| Interval Execution | < 10ms | < 50ms |
| Database Write | < 5ms | < 20ms |
| Database Read | < 10ms | < 50ms |
| WebSocket Message | < 5ms | < 20ms |
| Indicator Calculation | < 5ms | < 20ms |
| Candle Processing | < 10ms | < 50ms |

### Scaling Guidelines

#### 1-Hour Test

- **Expected Duration**: ~1 hour
- **Expected Operations**:
  - ~36,000 interval executions (10 intervals @ 100ms)
  - ~1,000 database writes
  - ~36,000 indicator calculations
- **Expected Memory Growth**: < 5 MB
- **Expected CPU Usage**: < 30%

#### 24-Hour Test

- **Expected Duration**: ~24 hours
- **Expected Operations**:
  - ~864,000 interval executions
  - ~24,000 database writes
  - ~864,000 indicator calculations
- **Expected Memory Growth**: < 50 MB
- **Expected CPU Usage**: < 40%

#### 7-Day Test

- **Expected Duration**: ~7 days
- **Expected Operations**:
  - ~6,048,000 interval executions
  - ~168,000 database writes
  - ~6,048,000 indicator calculations
- **Expected Memory Growth**: < 200 MB
- **Expected CPU Usage**: < 50%

### Performance Degradation

Monitor for performance degradation over time:

| Metric | Healthy | Warning | Critical |
|--------|----------|----------|----------|
| Memory Growth Rate | < 0.5 MB/s | 0.5-1 MB/s | > 1 MB/s |
| Event Loop Lag | < 20ms | 20-50ms | > 50ms |
| CPU Usage | < 40% | 40-70% | > 70% |
| Error Rate | < 1% | 1-5% | > 5% |

---

## Test Coverage

### Memory Leak Tests

- [x] Verify event listeners are removed on shutdown
- [x] Verify timers are cleared on shutdown
- [x] Verify intervals are cleared on shutdown
- [x] Verify no memory growth over time

### Exception Handling Tests

- [x] Verify try-catch blocks catch errors
- [x] Verify promise rejections are handled
- [x] Verify error handlers are called
- [x] Verify graceful error recovery

### Performance Tests

- [x] Verify synchronous operations don't block event loop
- [x] Verify database operations complete within thresholds
- [x] Verify WebSocket message processing is efficient
- [x] Verify indicator calculations are optimized

### WebSocket Resilience Tests

- [x] Verify reconnection works after disconnect
- [x] Verify pong timeout triggers reconnection
- [x] Verify message buffering works
- [x] Verify subscriptions are restored after reconnect

### Database Tests

- [x] Verify WAL mode is enabled
- [x] Verify transactions work correctly
- [x] Verify batch sync completes successfully
- [x] Verify connection state is tracked

### Background Process Tests

- [x] Verify intervals are tracked by intervalManager
- [x] Verify background sync completes
- [x] Verify graceful shutdown works
- [x] Verify no zombie processes remain

---

## Continuous Integration

### CI/CD Configuration

Add endurance tests to CI/CD pipeline:

```yaml
# .github/workflows/endurance-tests.yml
name: Endurance Tests

on:
  schedule:
    - cron: '0 0 * * 0' # Run weekly on Sunday
  workflow_dispatch:

jobs:
  endurance-test:
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Run endurance tests
        run: npm test -- tests/endurance/endurance-validation.test.ts -- --testTimeout=3600000

      - name: Upload test results
        uses: actions/upload-artifact@v3
        with:
          name: endurance-test-results
          path: test-results/
```

### Automated Reporting

Configure automated test reporting:

```typescript
// Add to CI/CD pipeline
import { runQuickTest } from './tests/endurance/runner.js';

const report = await runQuickTest([
    {
        name: 'WebSocket Reconnection',
        run: async (monitor) => {
            // Test implementation
        }
    }
]);

// Upload report to monitoring service
await uploadToMonitoringService(report);

// Fail if tests don't pass
if (report.summary.passRate < 100) {
    process.exit(1);
}
```

---

## Best Practices

### Test Design

1. **Isolation**: Each test should be independent and not rely on other tests
2. **Cleanup**: Always clean up resources after each test
3. **Assertions**: Use specific assertions with clear failure messages
4. **Timeouts**: Set appropriate timeouts for each test
5. **Logging**: Log relevant information for debugging

### Resource Management

1. **Intervals**: Always use IntervalManager for interval creation
2. **Timers**: Always clear timers when done
3. **Listeners**: Always remove event listeners when done
4. **Connections**: Always close connections when done
5. **Memory**: Always release references when done

### Error Handling

1. **Try-Catch**: Wrap all async operations in try-catch
2. **Promise Rejection**: Handle promise rejections
3. **Error Logging**: Log all errors with context
4. **Graceful Degradation**: Degrade gracefully under errors
5. **Recovery**: Implement recovery mechanisms for transient errors

---

## Additional Resources

### Documentation

- [Logging System](./LOGGING_SYSTEM.md)
- [Database Connection Audit](./DATABASE_CONNECTION_AUDIT.md)
- [WebSocket Resilience Analysis](./WEBSOCKET_RESILIENCE_ANALYSIS.md)

### Source Code

- [Monitor Utilities](../tests/endurance/monitor.ts)
- [Test Helpers](../tests/endurance/helpers.ts)
- [Test Runner](../tests/endurance/runner.ts)
- [Test Scenarios](../tests/endurance/scenarios/)

### Related Tests

- [Unit Tests](../tests/unit/)
- [Integration Tests](../tests/integration/)

---

## Support

For issues or questions about endurance testing:

1. Check this guide for common issues
2. Review test logs for detailed error information
3. Check source code for implementation details
4. Consult the troubleshooting guide above

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-04 | Initial endurance test suite |

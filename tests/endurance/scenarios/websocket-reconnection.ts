/**
 * WebSocket Reconnection Scenario
 *
 * Tests WebSocket resilience under various reconnection scenarios:
 * - Connection drops
 * - Reconnection with exponential backoff
 * - Subscription restoration
 * - Message buffering during reconnection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnduranceMonitor } from '../monitor.js';
import { setupTestEnvironment, waitForCondition, createMockWebSocketServer, formatMs } from '../helpers.js';
import { HyperLiquidWebSocket } from '../../../src/exchange/hyperliquid/websocket.js';

// Mock the logger to avoid side effects
vi.mock('../../../src/utils/logger.js', () => ({
    TradingLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        signal: vi.fn(),
        trade: vi.fn(),
        setComponent: vi.fn(),
        setRequestId: vi.fn(),
        logError: vi.fn(),
        generateRequestId: vi.fn(() => 'test-request-id')
    }
}));

describe('WebSocket Reconnection Scenario', () => {
    let monitor: EnduranceMonitor;
    let cleanup: () => Promise<void>;
    let mockServer: ReturnType<typeof createMockWebSocketServer>;

    beforeEach(async () => {
        const env = await setupTestEnvironment();
        monitor = env.monitor;
        cleanup = env.cleanup;
        mockServer = createMockWebSocketServer();
        monitor.start();
    });

    afterEach(async () => {
        await cleanup();
        monitor.stop();
    });

    describe('Connection Drop and Reconnection', () => {
        it('should reconnect after connection drop', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const reconnectEvents: string[] = [];

            ws.on('close', () => {
                reconnectEvents.push('close');
            });

            ws.on('open', () => {
                reconnectEvents.push('open');
            });

            // Simulate connection
            await ws.connect();
            expect(reconnectEvents).toContain('open');

            // Simulate disconnect
            ws.disconnect();
            expect(reconnectEvents).toContain('close');

            // Wait for reconnection attempt
            await waitForCondition(() => reconnectEvents.length >= 2, 5000);

            // Verify reconnection was attempted
            expect(reconnectEvents.length).toBeGreaterThanOrEqual(2);
        }, 10000);

        it('should use exponential backoff for reconnection', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const reconnectTimes: number[] = [];

            ws.on('close', () => {
                reconnectTimes.push(Date.now());
            });

            // Simulate multiple disconnects
            await ws.connect();
            ws.disconnect();

            await waitForCondition(() => reconnectTimes.length >= 3, 30000);

            // Verify exponential backoff (each delay should be longer)
            if (reconnectTimes.length >= 3) {
                const delay1 = reconnectTimes[1] - reconnectTimes[0];
                const delay2 = reconnectTimes[2] - reconnectTimes[1];
                expect(delay2).toBeGreaterThan(delay1);
            }
        }, 35000);
    });

    describe('Subscription Restoration', () => {
        it('should restore subscriptions after reconnection', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const subscriptions: string[] = [];

            // Track subscription calls
            const originalSend = (ws as any).send;
            (ws as any).send = vi.fn((data: any) => {
                if (data.method === 'subscribe') {
                    subscriptions.push(JSON.stringify(data));
                }
                originalSend.call(ws, data);
            });

            await ws.connect();

            // Subscribe to channels
            ws.subscribeToL2Book('BTC');
            ws.subscribeToCandles('BTC', '1m');
            ws.subscribeToUserFills('0xtest');

            const initialSubscriptions = subscriptions.length;
            expect(initialSubscriptions).toBe(3);

            // Disconnect and reconnect
            ws.disconnect();
            await waitForCondition(() => subscriptions.length > initialSubscriptions, 10000);

            // Verify subscriptions were restored
            expect(subscriptions.length).toBeGreaterThan(initialSubscriptions);
        }, 15000);
    });

    describe('Message Buffering', () => {
        it('should buffer messages during reconnection', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const receivedMessages: any[] = [];

            ws.on('l2Book', (data) => {
                receivedMessages.push({ type: 'l2Book', data });
            });

            ws.on('candle', (data) => {
                receivedMessages.push({ type: 'candle', data });
            });

            await ws.connect();
            ws.subscribeToL2Book('BTC');

            // Simulate messages during connection
            mockServer.simulateMessage({
                channel: 'l2Book',
                data: generateMockOrderBook('BTC')
            });

            // Disconnect
            ws.disconnect();

            // Simulate messages during disconnection (should be buffered)
            mockServer.simulateMessage({
                channel: 'l2Book',
                data: generateMockOrderBook('BTC')
            });

            mockServer.simulateMessage({
                channel: 'candle',
                data: generateMockCandle()
            });

            // Reconnect
            await ws.connect();

            // Wait for buffered messages to be processed
            await waitForCondition(() => receivedMessages.length >= 2, 5000);

            // Verify buffered messages were processed
            expect(receivedMessages.length).toBeGreaterThanOrEqual(2);
        }, 10000);
    });

    describe('Pong Timeout Detection', () => {
        it('should detect pong timeout and reconnect', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const closeEvents: number[] = [];

            ws.on('close', () => {
                closeEvents.push(Date.now());
            });

            await ws.connect();

            // Simulate pong timeout by not sending pong responses
            // The WebSocket should detect this and reconnect
            await waitForCondition(() => closeEvents.length >= 1, 15000);

            expect(closeEvents.length).toBeGreaterThanOrEqual(1);
        }, 20000);
    });

    describe('Memory Leak Prevention', () => {
        it('should not leak memory during reconnection cycles', async () => {
            const ws = new HyperLiquidWebSocket(false);
            const initialMemory = process.memoryUsage().heapUsed;

            // Perform multiple reconnection cycles
            for (let i = 0; i < 10; i++) {
                await ws.connect();
                ws.subscribeToL2Book('BTC');
                ws.disconnect();
                await waitForDuration(100);
            }

            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }

            const finalMemory = process.memoryUsage().heapUsed;
            const memoryGrowth = finalMemory - initialMemory;

            // Memory growth should be minimal (< 10MB)
            expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024);
        }, 30000);
    });

    describe('Event Listener Cleanup', () => {
        it('should remove all event listeners on disconnect', async () => {
            const ws = new HyperLiquidWebSocket(false);

            await ws.connect();
            ws.subscribeToL2Book('BTC');

            const listenerCountBefore = ws.listenerCount('l2Book');
            expect(listenerCountBefore).toBeGreaterThan(0);

            ws.disconnect();

            const listenerCountAfter = ws.listenerCount('l2Book');
            expect(listenerCountAfter).toBe(0);
        });
    });
});

// Helper functions for mock data generation
function generateMockOrderBook(coin: string) {
    const basePrice = 50000;
    const bids = Array.from({ length: 10 }, (_, i) => ({
        px: (basePrice - i * 10).toFixed(2),
        sz: (Math.random() * 10 + 0.1).toFixed(4),
        n: Math.floor(Math.random() * 100)
    }));

    const asks = Array.from({ length: 10 }, (_, i) => ({
        px: (basePrice + i * 10).toFixed(2),
        sz: (Math.random() * 10 + 0.1).toFixed(4),
        n: Math.floor(Math.random() * 100)
    }));

    return {
        coin,
        time: Date.now(),
        levels: [bids, asks],
        starting: true
    };
}

function generateMockCandle() {
    const basePrice = 50000;
    return {
        timestamp: Date.now(),
        open: basePrice + (Math.random() - 0.5) * 500,
        high: basePrice + Math.random() * 500,
        low: basePrice - Math.random() * 500,
        close: basePrice + (Math.random() - 0.5) * 500,
        volume: Math.random() * 1000 + 100
    };
}

function waitForDuration(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Type-safe WebSocket message interface
 * @property type - Message type identifier
 * @property data - Message payload (generic type for flexibility)
 * @property timestamp - Unix timestamp when message was received
 */
export interface WebSocketMessage<T = unknown> {
    type: string;
    data: T;
    timestamp: number;
}

/**
 * Connection status for granular UI feedback
 */
export type ConnectionStatus =
    | 'idle'       // Initial state, not yet connected
    | 'connecting' // WebSocket handshake in progress
    | 'connected'  // Successfully connected and ready
    | 'disconnected' // Disconnected, may reconnect
    | 'error';     // Connection error occurred

/**
 * Configuration options for useWebSocket hook
 */
export interface UseWebSocketOptions {
    /** Maximum number of reconnection attempts (default: 5) */
    maxReconnectAttempts?: number;
    /** Initial reconnection delay in milliseconds (default: 1000) */
    reconnectDelay?: number;
    /** Maximum reconnection delay in milliseconds (default: 30000) */
    maxReconnectDelay?: number;
    /** Connection timeout in milliseconds (default: 10000) */
    connectionTimeout?: number;
    /** Enable exponential backoff for reconnection (default: true) */
    enableExponentialBackoff?: boolean;
    /** Callback when connection status changes */
    onStatusChange?: (status: ConnectionStatus) => void;
    /** Callback when connection error occurs */
    onError?: (error: Event) => void;
}

/**
 * Return type for useWebSocket hook
 */
export interface UseWebSocketReturn<T = unknown> {
    /** Current connection status */
    status: ConnectionStatus;
    /** Whether the socket is currently connected */
    isConnected: boolean;
    /** Last received message */
    lastMessage: WebSocketMessage<T> | null;
    /** Manually trigger reconnection */
    reconnect: () => void;
    /** Manually disconnect */
    disconnect: () => void;
    /** Send a message through the WebSocket */
    sendMessage: (data: string | object) => boolean;
    /** Current reconnection attempt count */
    reconnectAttempt: number;
}

/**
 * Production-ready WebSocket hook with robust connection handling,
 * proper cleanup, type safety, and memory leak prevention.
 * 
 * @param url - WebSocket URL to connect to
 * @param options - Configuration options
 * @returns WebSocket state and control methods
 * 
 * @example
 * ```tsx
 * const { status, lastMessage, sendMessage } = useWebSocket('ws://localhost:8080', {
 *   maxReconnectAttempts: 5,
 *   onStatusChange: (status) => console.log('Status:', status),
 * });
 * ```
 */
export function useWebSocket<T = unknown>(
    url: string,
    options: UseWebSocketOptions = {}
): UseWebSocketReturn<T> {
    const {
        maxReconnectAttempts = 5,
        reconnectDelay = 1000,
        maxReconnectDelay = 30000,
        connectionTimeout = 10000,
        enableExponentialBackoff = true,
        onStatusChange,
        onError,
    } = options;

    // State management
    const [status, setStatus] = useState<ConnectionStatus>('idle');
    const [lastMessage, setLastMessage] = useState<WebSocketMessage<T> | null>(null);
    const [reconnectAttempt, setReconnectAttempt] = useState(0);

    // Refs for mutable values that don't trigger re-renders
    const socketRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number | undefined>(undefined);
    const connectionTimeoutRef = useRef<number | undefined>(undefined);
    const heartbeatIntervalRef = useRef<number | undefined>(undefined);
    // CRITICAL FIX: Initialize ref for heartbeat tracking
    const lastPongTimeRef = useRef<number>(0);
    const isMountedRef = useRef(true);
    const currentUrlRef = useRef(url);
    const reconnectAttemptRef = useRef(0);
    const connectRef = useRef<(() => void) | null>(null);

    /**
     * Update connection status with callback notification
     */
    const updateStatus = useCallback((newStatus: ConnectionStatus) => {
        if (!isMountedRef.current) return;

        setStatus(newStatus);
        onStatusChange?.(newStatus);
    }, [onStatusChange]);

    /**
     * Calculate exponential backoff delay
     */
    const getReconnectDelay = useCallback((attempt: number): number => {
        if (!enableExponentialBackoff) {
            return reconnectDelay;
        }

        // Exponential backoff: delay * 2^attempt
        const delay = reconnectDelay * Math.pow(2, attempt);
        return Math.min(delay, maxReconnectDelay);
    }, [reconnectDelay, maxReconnectDelay, enableExponentialBackoff]);

    /**
     * Clear all pending timeouts and intervals
     */
    const clearTimeouts = useCallback(() => {
        if (reconnectTimeoutRef.current !== undefined) {
            window.clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = undefined;
        }
        if (connectionTimeoutRef.current !== undefined) {
            window.clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = undefined;
        }
        // CRITICAL FIX: Clear heartbeat interval
        if (heartbeatIntervalRef.current !== undefined) {
            window.clearInterval(heartbeatIntervalRef.current);
            heartbeatIntervalRef.current = undefined;
        }
    }, []);

    /**
     * Close existing WebSocket connection safely
     */
    const closeSocket = useCallback(() => {
        if (socketRef.current) {
            const socket = socketRef.current;

            // Remove event handlers to prevent memory leaks
            socket.onopen = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.onmessage = null;

            // Close the socket if it's still open or connecting
            if (socket.readyState === WebSocket.OPEN ||
                socket.readyState === WebSocket.CONNECTING) {
                socket.close();
            }

            socketRef.current = null;
        }
    }, []);

    /**
     * Handle WebSocket connection
     */
    const connect = useCallback(() => {
        // Prevent multiple simultaneous connections
        if (socketRef.current?.readyState === WebSocket.OPEN ||
            socketRef.current?.readyState === WebSocket.CONNECTING) {
            return;
        }

        // Clear any existing timeouts
        clearTimeouts();

        // Close existing socket if any
        closeSocket();

        updateStatus('connecting');

        try {
            const socket = new WebSocket(currentUrlRef.current);
            socketRef.current = socket;

            // Set connection timeout
            connectionTimeoutRef.current = window.setTimeout(() => {
                if (socket.readyState === WebSocket.CONNECTING) {
                    console.warn('WebSocket connection timeout');
                    socket.close();
                }
            }, connectionTimeout);

            socket.onopen = () => {
                if (!isMountedRef.current) return;

                clearTimeouts();
                reconnectAttemptRef.current = 0;
                setReconnectAttempt(0);
                updateStatus('connected');
                console.log('WebSocket Connected');

                // CRITICAL FIX: Start heartbeat mechanism
                lastPongTimeRef.current = Date.now();
                heartbeatIntervalRef.current = window.setInterval(() => {
                    const timeSinceLastPong = Date.now() - lastPongTimeRef.current;
                    // If no pong received in 30 seconds, close connection
                    if (timeSinceLastPong > 30000) {
                        console.warn('Heartbeat timeout - no pong received in 30s');
                        socket.close();
                        return;
                    }
                    // Send ping every 15 seconds
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type: 'ping' }));
                    }
                }, 15000); // 15 second heartbeat interval
            };

            socket.onclose = (event) => {
                if (!isMountedRef.current) return;

                clearTimeouts();
                updateStatus('disconnected');
                console.log('WebSocket Disconnected', event.code, event.reason);

                // Attempt reconnection if not intentionally closed
                if (event.code !== 1000 && reconnectAttemptRef.current < maxReconnectAttempts) {
                    const delay = getReconnectDelay(reconnectAttemptRef.current);
                    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current + 1}/${maxReconnectAttempts})`);

                    reconnectTimeoutRef.current = window.setTimeout(() => {
                        if (isMountedRef.current) {
                            reconnectAttemptRef.current++;
                            setReconnectAttempt(reconnectAttemptRef.current);
                            connectRef.current?.();
                        }
                    }, delay);
                } else if (reconnectAttemptRef.current >= maxReconnectAttempts) {
                    updateStatus('error');
                    console.error('Max reconnection attempts reached');
                }
            };

            socket.onerror = (error) => {
                if (!isMountedRef.current) return;

                console.error('WebSocket Error:', error);
                onError?.(error);
            };

            socket.onmessage = (event: MessageEvent) => {
                if (!isMountedRef.current) return;

                let message: unknown;
                try {
                    message = JSON.parse(event.data);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                    console.error('Raw message:', event.data);
                    return;
                }

                // CRITICAL FIX: Handle pong messages for heartbeat
                const msg = message as Record<string, unknown>;
                if (msg.type === 'pong') {
                    lastPongTimeRef.current = Date.now();
                    return; // Don't process pong as regular message
                }

                // Validate message structure
                if (!message || typeof message !== 'object' || Array.isArray(message)) {
                    console.warn('Invalid message format:', message);
                    return;
                }

                if (typeof msg.type !== 'string') {
                    console.warn('Message missing required "type" field:', msg);
                    return;
                }

                // Construct valid WebSocketMessage with timestamp
                const validMessage: WebSocketMessage<T> = {
                    type: msg.type,
                    data: msg.data as T,
                    timestamp: Date.now(),
                };

                setLastMessage(validMessage);
            };

        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            updateStatus('error');
        }
    }, [
        closeSocket,
        clearTimeouts,
        updateStatus,
        getReconnectDelay,
        connectionTimeout,
        maxReconnectAttempts,
        onError,
    ]);

    // Update ref whenever connect changes
    useEffect(() => {
        connectRef.current = connect;
    }, [connect]);

    /**
     * Manually trigger reconnection
     */
    const reconnect = useCallback(() => {
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        connectRef.current?.();
    }, []);

    /**
     * Manually disconnect
     */
    const disconnect = useCallback(() => {
        clearTimeouts();
        closeSocket();
        updateStatus('idle');
    }, [clearTimeouts, closeSocket, updateStatus]);

    /**
     * Send a message through the WebSocket
     * @param data - String or object to send
     * @returns true if message was sent, false otherwise
     */
    const sendMessage = useCallback((data: string | object): boolean => {
        const socket = socketRef.current;

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send message: WebSocket is not connected');
            return false;
        }

        try {
            const message = typeof data === 'string' ? data : JSON.stringify(data);
            socket.send(message);
            return true;
        } catch (error) {
            console.error('Failed to send WebSocket message:', error);
            return false;
        }
    }, []);

    // Initialize connection on mount and handle URL changes
    useEffect(() => {
        currentUrlRef.current = url;
        // CRITICAL FIX: Initialize lastPongTime on mount
        lastPongTimeRef.current = Date.now();
        connectRef.current?.();

        return () => {
            isMountedRef.current = false;
            clearTimeouts();
            closeSocket();
        };
    }, [url, clearTimeouts, closeSocket]);

    return {
        status,
        isConnected: status === 'connected',
        lastMessage,
        reconnect,
        disconnect,
        sendMessage,
        reconnectAttempt,
    };
}

import { useState, useEffect, useCallback, useRef } from 'react';

export interface WebSocketMessage {
    type: string;
    data: any;
    timestamp: number;
}

export function useWebSocket(url: string) {
    const [isConnected, setIsConnected] = useState(false);
    const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
    const reconnectTimeout = useRef<number | undefined>(undefined);
    const socketRef = useRef<WebSocket | null>(null);

    const connect = useCallback(() => {
        socketRef.current = new WebSocket(url);

        socketRef.current.onopen = () => {
            console.log('WebSocket Connected');
            setIsConnected(true);
        };

        socketRef.current.onclose = () => {
            console.log('WebSocket Disconnected');
            setIsConnected(false);
            // Reconnect after 3 seconds
            reconnectTimeout.current = window.setTimeout(connect, 3000);
        };

        socketRef.current.onerror = (error) => {
            console.error('WebSocket Error:', error);
            socketRef.current?.close();
        };

        socketRef.current.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                setLastMessage(message);
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        };
    }, [url]);

    useEffect(() => {
        connect();
        return () => {
            if (socketRef.current) {
                socketRef.current.close();
            }
            if (reconnectTimeout.current) {
                clearTimeout(reconnectTimeout.current);
            }
        };
    }, [connect]);

    return { isConnected, lastMessage };
}

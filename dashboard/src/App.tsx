import { useState, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { ChartWidget } from './components/ChartWidget';
import { PositionsTable } from './components/PositionsTable';
import type { Position } from './components/PositionsTable';
import { Activity, Radio } from 'lucide-react';

const TRADING_PAIRS = [
  'ETH-USDC',
  'BTC-USDC',
  'SOL-USDC',
  'HYPE-USDC'
];

function App() {
  const { isConnected, lastMessage } = useWebSocket('ws://localhost:8080');
  const [activePair, setActivePair] = useState('ETH-USDC');
  const [positions, setPositions] = useState<Position[]>([]);
  const [candleData, setCandleData] = useState<Record<string, any[]>>({});

  useEffect(() => {
    if (!lastMessage) return;

    const { type, data } = lastMessage;

    if (type === 'price_update') {
      const { pair, candle } = data;
      // Convert candle to lightweight-charts format
      const chartCandle = {
        time: candle.timestamp / 1000, // Seconds
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: parseFloat(candle.close),
      };

      setCandleData(prev => {
        const pairData = prev[pair] || [];
        // Ideally we merge or append. For real-time, update last if same time, else push.
        const last = pairData[pairData.length - 1];
        if (last && last.time === chartCandle.time) {
          // Update existing
          return { ...prev, [pair]: [...pairData.slice(0, -1), chartCandle] };
        } else {
          // Append new
          // Limit to last 500 candles to avoid memory leak if running long
          const newData = [...pairData, chartCandle].slice(-500);
          return { ...prev, [pair]: newData };
        }
      });
    }

    if (type === 'position_update') {
      // data: { status: 'opened'|'closed'|'updated', pair, ...positionDetails }
      // We need to maintain the list of active positions
      const { status, pair } = data;

      setPositions(prev => {
        if (status === 'closed') {
          return prev.filter(p => p.pair !== pair);
        } else {
          // Opened or Updated
          const newPos: Position = {
            pair: data.pair,
            direction: data.direction,
            size: data.size.toString(),
            entryPrice: data.entryPrice.toString(),
            stopLoss: data.stopLoss.toString(),
            takeProfit: data.takeProfit?.toString(),
            timestamp: new Date(data.timestamp).toISOString(),
            pnl: data.pnl?.toString() // Only if closed/updated with PnL? 
            // Actually 'updated' (trailing stop) might not have PnL yet.
          };

          // Remove existing if present (update)
          const others = prev.filter(p => p.pair !== pair);
          return [...others, newPos];
        }
      });
    }
  }, [lastMessage]);

  return (
    <div id="root">
      <div className="container">
        <header className="header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <Activity className="icon" color="#26a69a" />
            <h1>Hyperliquid Super Signal</h1>
          </div>
          <div className={`status-badge ${isConnected ? 'status-connected' : 'status-disconnected'}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Radio size={16} />
              {isConnected ? 'Connected' : 'Disconnected'}
            </div>
          </div>
        </header>

        <div className="pair-selector" style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem' }}>
          {TRADING_PAIRS.map(pair => (
            <button
              key={pair}
              onClick={() => setActivePair(pair)}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: activePair === pair ? '#26a69a' : '#1a1a1a',
                border: '1px solid #333',
                color: 'white',
                cursor: 'pointer'
              }}
            >
              {pair}
            </button>
          ))}
        </div>

        <div className="grid">
          <div className="main-content">
            <ChartWidget
              data={candleData[activePair] || []}
              pair={activePair}
            />
          </div>

          <div className="sidebar">
            <PositionsTable positions={positions} />

            <div className="card" style={{ marginTop: '1rem' }}>
              <h2>Recent logs</h2>
              <div style={{ fontSize: '0.8rem', color: '#888', maxHeight: '200px', overflowY: 'auto' }}>
                {/* Logs would go here if streamed */}
                Waiting for logs...
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

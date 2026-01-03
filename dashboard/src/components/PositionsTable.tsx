
export interface Position {
    pair: string;
    direction: 'long' | 'short';
    size: string;
    entryPrice: string;
    pnl?: string;
    stopLoss: string;
    takeProfit?: string;
    timestamp: string;
}

export const PositionsTable = ({ positions }: { positions: Position[] }) => {
    return (
        <div className="card">
            <h2>Active Positions</h2>
            {positions.length === 0 ? (
                <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No active positions</p>
            ) : (
                <table>
                    <thead>
                        <tr>
                            <th>Pair</th>
                            <th>Side</th>
                            <th>Size</th>
                            <th>Entry</th>
                            <th>Current PnL</th>
                        </tr>
                    </thead>
                    <tbody>
                        {positions.map((pos) => (
                            <tr key={pos.pair}>
                                <td>{pos.pair}</td>
                                <td className={pos.direction}>{pos.direction.toUpperCase()}</td>
                                <td>{parseFloat(pos.size).toFixed(4)}</td>
                                <td>{parseFloat(pos.entryPrice).toFixed(2)}</td>
                                <td className={parseFloat(pos.pnl || '0') >= 0 ? 'long' : 'short'}>
                                    {pos.pnl ? parseFloat(pos.pnl).toFixed(2) : '-'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
};

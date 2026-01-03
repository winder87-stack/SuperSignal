import { HyperLiquidWebSocket } from '../src/exchange/hyperliquid/websocket.js';
import { TradingLogger } from '../src/utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    TradingLogger.info("Starting HyperLiquid WebSocket Test...");

    const ws = new HyperLiquidWebSocket(false); // Mainnet by default? Or Testnet?
    // Let's use false (Mainnet) for pure L2Book data test as it is always active.

    ws.on('l2Book', (book) => {
        console.log(`[L2Book] ${book.coin} - Bid: ${book.levels[0][0].px} @ ${book.levels[0][0].sz}`);
        // Terminate after receiving data
        setTimeout(() => {
            console.log("Received data, test passed.");
            process.exit(0);
        }, 100);
    });

    await ws.connect();
    console.log("Connected.");

    // Subscribe to ETH
    ws.subscribeToL2Book('ETH');

    // Keep alive for a bit
    setTimeout(() => {
        console.log("Timeout reached.");
        process.exit(1);
    }, 10000);
}

main().catch(console.error);

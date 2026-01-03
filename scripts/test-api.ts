import { HyperLiquidAPI } from '../src/exchange/hyperliquid/api.js';
import { TradingLogger } from '../src/utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    TradingLogger.info("Starting HyperLiquid API Test...");

    // Use a dummy private key if env is missing, for public endpoints it might not be verified strictly 
    // BUT we initialize wallet with it.
    // If we only call public endpoints, it won't sign.
    const pk = process.env.HL_WALLET_PRIVATE_KEY || "0x0123456789012345678901234567890123456789012345678901234567890123";
    const isTestnet = false; // Mainnet

    const api = new HyperLiquidAPI(pk, isTestnet);

    try {
        console.log("Fetching Meta and Asset Contexts...");
        const meta = await api.getMetaAndAssetCtxs();
        console.log("Success!");
        console.log("Universe size:", meta[0].universe.length);
        console.log("First asset:", meta[0].universe[0]);
    } catch (err: any) {
        console.error("API Error:", err.message);
        process.exit(1);
    }
}

main();

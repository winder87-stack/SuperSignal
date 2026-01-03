#!/usr/bin/env npx ts-node
/**
 * Fetch Historical Candles from HyperLiquid
 * 
 * Usage: npx ts-node scripts/fetchCandles.ts
 * 
 * Fetches 14 days of 3-minute candles for SOL and BTC
 * Saves to data/candles/{coin}_3m.json
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const API_URL = 'https://api.hyperliquid.xyz/info';

interface RawCandle {
    t: number;  // Open time
    T: number;  // Close time
    s: string;  // Symbol
    i: string;  // Interval
    o: string;  // Open
    c: string;  // Close
    h: string;  // High
    l: string;  // Low
    v: string;  // Volume
    n: number;  // Number of trades
}

async function fetchCandleSnapshot(
    coin: string,
    interval: string,
    startTime: number,
    endTime: number
): Promise<RawCandle[]> {
    const response = await axios.post(API_URL, {
        type: 'candleSnapshot',
        req: {
            coin,
            interval,
            startTime,
            endTime
        }
    });
    return response.data;
}

async function fetchAllCandles(coin: string, days: number = 14): Promise<RawCandle[]> {
    const interval = '3m';
    const intervalMs = 3 * 60 * 1000; // 3 minutes
    const now = Date.now();
    const startTime = now - (days * 24 * 60 * 60 * 1000);

    console.log(`Fetching ${days} days of ${interval} candles for ${coin}...`);
    console.log(`  Start: ${new Date(startTime).toISOString()}`);
    console.log(`  End:   ${new Date(now).toISOString()}`);

    // HyperLiquid may limit results per request, so we fetch in chunks
    const chunkDays = 2; // Fetch 2 days at a time
    const chunkMs = chunkDays * 24 * 60 * 60 * 1000;

    const allCandles: RawCandle[] = [];
    let currentStart = startTime;

    while (currentStart < now) {
        const chunkEnd = Math.min(currentStart + chunkMs, now);

        try {
            const candles = await fetchCandleSnapshot(coin, interval, currentStart, chunkEnd);
            allCandles.push(...candles);
            console.log(`  Fetched ${candles.length} candles (${new Date(currentStart).toISOString().split('T')[0]})`);
        } catch (error: any) {
            console.error(`  Error fetching chunk: ${error.message}`);
        }

        currentStart = chunkEnd;

        // Rate limit: wait 200ms between requests
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Sort by timestamp and dedupe
    const uniqueCandles = Array.from(
        new Map(allCandles.map(c => [c.t, c])).values()
    ).sort((a, b) => a.t - b.t);

    console.log(`  Total unique candles: ${uniqueCandles.length}`);
    return uniqueCandles;
}

async function main() {
    const coins = ['SOL', 'BTC'];
    const days = 14;

    // Ensure data directory exists
    const dataDir = path.join(process.cwd(), 'data', 'candles');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    for (const coin of coins) {
        const candles = await fetchAllCandles(coin, days);

        const filename = path.join(dataDir, `${coin}_3m.json`);
        fs.writeFileSync(filename, JSON.stringify(candles, null, 2));

        console.log(`\nSaved ${candles.length} candles to ${filename}`);

        // Print sample
        if (candles.length > 0) {
            console.log(`  First: ${new Date(candles[0].t).toISOString()} @ ${candles[0].c}`);
            console.log(`  Last:  ${new Date(candles[candles.length - 1].t).toISOString()} @ ${candles[candles.length - 1].c}`);
        }
    }

    console.log('\nDone!');
}

main().catch(console.error);

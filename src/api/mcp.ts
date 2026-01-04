import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TradingEngine } from "../core/engine.js";
import { TradingLogger } from "../utils/logger.js";
import { TRADING_PAIRS } from "../types/index.js";

export class BotMcpServer {
    private server: McpServer;

    private engine: TradingEngine;

    constructor(engine: TradingEngine) {
        this.engine = engine;
        this.server = new McpServer({
            name: "hyperliquid-super-signal",
            version: "1.0.0",
        });

        this.setupTools();
    }

    private setupTools(): void {
        // Tool: Get Bot Status
        this.server.tool(
            "get_status",
            {},
            async () => {
                const positions = this.engine.getPositions();
                // Calculate rough PnL (real PnL is in RiskManager, but let's just sum current positions for now)
                // We'll return basic stats
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            running: true, // If this server is running, the bot is running
                            activePairs: TRADING_PAIRS.length,
                            openPositions: positions.length,
                            totalPnL: "Check RiskManager (not exposed yet)"
                        }, null, 2)
                    }]
                };
            }
        );

        // Tool: Get Positions
        this.server.tool(
            "get_positions",
            {},
            async () => {
                const positions = this.engine.getPositions();
                // Convert BigInts/Decimals to string for JSON
                const safePositions = positions.map((p): {
                    pair: string;
                    direction: string;
                    size: string;
                    entryPrice: string;
                    pnl: string;
                    stopLoss: string;
                    takeProfit?: string;
                    trailingStop?: string;
                    timestamp: string;
                } => ({
                    pair: p.pair,
                    direction: p.direction,
                    size: p.size.toString(),
                    entryPrice: p.entryPrice.toString(),
                    pnl: "Calculated in engine", // Engine doesn't store unrealized PnL in Position object yet
                    stopLoss: p.stopLoss.toString(),
                    takeProfit: p.takeProfit?.toString(),
                    trailingStop: p.trailingStop?.toString(),
                    timestamp: new Date(p.timestamp).toISOString()
                }));

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(safePositions, null, 2)
                    }]
                };
            }
        );

        // Tool: Get Logs
        this.server.tool(
            "get_logs",
            { count: z.number().optional().describe("Number of logs to return (default 20)") },
            async ({ count }) => {
                const logs = TradingLogger.getRecentLogs(count || 20);
                return {
                    content: [{
                        type: "text",
                        text: logs.map(l => `[${new Date(l.timestamp).toISOString()}] [${l.level.toUpperCase()}] ${l.message}`).join("\n")
                    }]
                };
            }
        );
    }

    public async start(): Promise<void> {
        // Use Stdio transport for local agent interaction
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        // Log to stderr because stdout is used by MCP
        console.error("MCP Server started via Stdio");
    }
}

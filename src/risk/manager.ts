import { Decimal } from 'decimal.js';
import { TradingLogger } from '../utils/logger.js';
import { RiskConfig, Position, TradingPair } from '../types/index.js';
import { FinancialMath } from '../utils/math.js';

export class RiskManager {
    private config: RiskConfig;
    private dailyPnl: Decimal = new Decimal(0);
    private lastResetDate: string;

    constructor(config: RiskConfig) {
        this.config = config;
        this.lastResetDate = new Date().toISOString().split('T')[0];
    }

    /**
     * Calculate position size based on account balance and risk parameters
     * @param accountBalance - Current account balance in USD
     * @param entryPrice - Entry price for the trade
     * @param stopLoss - Stop loss price
     * @returns Position size in USD
     */
    public calculatePositionSize(
        accountBalance: Decimal,
        entryPrice: Decimal,
        stopLoss: Decimal
    ): Decimal {
        // Calculate risk amount (how much we're willing to lose)
        const riskAmount = accountBalance.mul(this.config.riskPercentage);

        // Calculate the stop loss distance as a percentage
        const stopLossDistance = entryPrice.sub(stopLoss).abs().div(entryPrice);

        // If stop loss is at the same price as entry (should not happen), use default SL%
        const effectiveStopLossDistance = stopLossDistance.isZero()
            ? this.config.stopLossPercentage
            : stopLossDistance;

        // Position size = Risk Amount / Stop Loss Distance
        // This ensures if we hit SL, we lose exactly riskAmount
        let positionSize = riskAmount.div(effectiveStopLossDistance);

        // Cap at max position size
        if (FinancialMath.greaterThan(positionSize, this.config.maxPositionSize)) {
            positionSize = this.config.maxPositionSize;
            TradingLogger.info(`Position size capped at max: ${positionSize.toString()}`);
        }

        // Minimum position size of $10 to avoid dust orders
        const minPositionSize = new Decimal(10);
        if (FinancialMath.lessThan(positionSize, minPositionSize)) {
            TradingLogger.warn(`Calculated position size ${positionSize.toString()} is below minimum $10`);
            return new Decimal(0); // Return 0 to indicate trade should be skipped
        }

        TradingLogger.info(
            `Position sizing: Balance=${accountBalance.toString()}, Risk%=${this.config.riskPercentage.mul(100).toString()}%, ` +
            `RiskAmount=${riskAmount.toString()}, SL%=${effectiveStopLossDistance.mul(100).toFixed(2)}%, Size=${positionSize.toFixed(2)}`
        );

        return positionSize;
    }

    /**
     * Check if a trade is allowed based on risk parameters
     */
    public canTrade(
        pair: TradingPair,
        size: Decimal,
        currentExposure: Decimal,
        openPositionsCount: number
    ): { allowed: boolean; reason?: string } {
        this.checkDailyReset();

        // 1. Daily Loss Circuit Breaker
        if (FinancialMath.lessThanOrEqual(this.dailyPnl, this.config.maxDrawdown.negated())) {
            return { allowed: false, reason: 'Daily loss limit reached' };
        }

        // 2. Max Position Size
        if (FinancialMath.greaterThan(size, this.config.maxPositionSize)) {
            return { allowed: false, reason: `Trade size exceeds maxPositionSize: ${this.config.maxPositionSize}` };
        }

        // 3. Max Total Exposure
        const newTotalExposure = FinancialMath.add(currentExposure, size);
        if (FinancialMath.greaterThan(newTotalExposure, this.config.maxTotalExposure)) {
            return { allowed: false, reason: 'Total exposure limit reached' };
        }

        // 4. Max Open Positions
        if (openPositionsCount >= 5) { // Hard limit of 5 concurrent pairs
            return { allowed: false, reason: 'Max concurrent positions reached' };
        }

        return { allowed: true };
    }

    /**
     * Update daily PnL (for circuit breakers)
     */
    public updatePnL(pnl: Decimal): void {
        this.dailyPnl = this.dailyPnl.add(pnl);
        TradingLogger.info(`Risk Update: Daily PnL = ${this.dailyPnl.toString()}`);
    }

    private checkDailyReset(): void {
        const today = new Date().toISOString().split('T')[0];
        if (this.lastResetDate !== today) {
            TradingLogger.info(`Resetting daily risk metrics from ${this.lastResetDate} to ${today}`);
            this.dailyPnl = new Decimal(0);
            this.lastResetDate = today;
        }
    }

    public getConfig(): RiskConfig {
        return this.config;
    }
}

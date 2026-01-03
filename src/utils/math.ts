// Financial Math Utilities - ALWAYS use decimal.js for money
import { Decimal } from 'decimal.js';

// Configure decimal.js for financial precision
Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -20,
  toExpPos: 20
});

// Financial Math Operations
export class FinancialMath {
  /**
   * Create Decimal from string/number - ALWAYS use this for prices/sizes
   */
  static decimal(value: string | number | Decimal): Decimal {
    if (value instanceof Decimal) return value;
    return new Decimal(value.toString());
  }

  /**
   * Check if a is less than or equal to b
   */
  static lessThanOrEqual(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return FinancialMath.decimal(a).lte(FinancialMath.decimal(b));
  }

  /**
   * Check if a is greater than or equal to b
   */
  static greaterThanOrEqual(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return FinancialMath.decimal(a).gte(FinancialMath.decimal(b));
  }

  /**
   * Safe addition
   */
  static add(a: Decimal | string | number, b: Decimal | string | number): Decimal {
    return FinancialMath.decimal(a).add(FinancialMath.decimal(b));
  }

  /**
   * Safe subtraction
   */
  static subtract(a: Decimal | string | number, b: Decimal | string | number): Decimal {
    return FinancialMath.decimal(a).sub(FinancialMath.decimal(b));
  }

  /**
   * Safe multiplication
   */
  static multiply(a: Decimal | string | number, b: Decimal | string | number): Decimal {
    return FinancialMath.decimal(a).mul(FinancialMath.decimal(b));
  }

  /**
   * Safe division
   */
  static divide(a: Decimal | string | number, b: Decimal | string | number): Decimal {
    const denominator = FinancialMath.decimal(b);
    if (denominator.isZero()) {
      throw new Error('Division by zero');
    }
    return FinancialMath.decimal(a).div(denominator);
  }

  /**
   * Calculate percentage
   */
  static percentage(value: Decimal | string | number, percentage: number): Decimal {
    return FinancialMath.multiply(value, FinancialMath.decimal(percentage).div(100));
  }

  /**
   * Calculate percentage change
   */
  static percentageChange(from: Decimal | string | number, to: Decimal | string | number): Decimal {
    const fromDecimal = FinancialMath.decimal(from);
    const toDecimal = FinancialMath.decimal(to);

    if (fromDecimal.isZero()) {
      return new Decimal(0);
    }

    return toDecimal.sub(fromDecimal).div(fromDecimal).mul(100);
  }

  /**
   * Round to specific decimal places
   */
  static round(value: Decimal | string | number, decimals: number): Decimal {
    return FinancialMath.decimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  }

  /**
   * Calculate PnL (Profit and Loss)
   */
  static calculatePnL(
    entryPrice: Decimal | string | number,
    exitPrice: Decimal | string | number,
    size: Decimal | string | number,
    direction: 'long' | 'short'
  ): Decimal {
    const entry = FinancialMath.decimal(entryPrice);
    const exit = FinancialMath.decimal(exitPrice);
    const positionSize = FinancialMath.decimal(size);

    const priceDiff = direction === 'long'
      ? exit.sub(entry)
      : entry.sub(exit);

    return priceDiff.mul(positionSize);
  }

  /**
   * Calculate stop loss price
   */
  static calculateStopLoss(
    entryPrice: Decimal | string | number,
    percentage: number,
    direction: 'long' | 'short'
  ): Decimal {
    const entry = FinancialMath.decimal(entryPrice);
    const stopPercentage = FinancialMath.decimal(percentage).div(100);

    if (direction === 'long') {
      return entry.mul(FinancialMath.decimal(1).sub(stopPercentage));
    } else {
      return entry.mul(FinancialMath.decimal(1).add(stopPercentage));
    }
  }

  /**
   * Check if value is within range (inclusive)
   */
  static isInRange(
    value: Decimal | string | number,
    min: Decimal | string | number,
    max: Decimal | string | number
  ): boolean {
    const val = FinancialMath.decimal(value);
    const minVal = FinancialMath.decimal(min);
    const maxVal = FinancialMath.decimal(max);

    return val.gte(minVal) && val.lte(maxVal);
  }

  /**
   * Clamp value between min and max
   */
  static clamp(
    value: Decimal | string | number,
    min: Decimal | string | number,
    max: Decimal | string | number
  ): Decimal {
    const val = FinancialMath.decimal(value);
    const minVal = FinancialMath.decimal(min);
    const maxVal = FinancialMath.decimal(max);

    if (val.lt(minVal)) return minVal;
    if (val.gt(maxVal)) return maxVal;
    return val;
  }

  /**
   * Format decimal for API calls (always as string)
   */
  static toString(value: Decimal | string | number): string {
    return FinancialMath.decimal(value).toString();
  }

  /**
   * Format decimal for display with specified decimals
   */
  static format(value: Decimal | string | number, decimals: number = 4): string {
    return FinancialMath.decimal(value).toFixed(decimals);
  }

  /**
   * Compare two decimals
   */
  static compare(a: Decimal | string | number, b: Decimal | string | number): number {
    return FinancialMath.decimal(a).comparedTo(FinancialMath.decimal(b));
  }

  /**
   * Check if a equals b
   */
  static equals(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return FinancialMath.decimal(a).equals(FinancialMath.decimal(b));
  }

  /**
   * Check if a is greater than b
   */
  static greaterThan(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return FinancialMath.decimal(a).gt(FinancialMath.decimal(b));
  }

  /**
   * Check if a is less than b
   */
  static lessThan(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return FinancialMath.decimal(a).lt(FinancialMath.decimal(b));
  }
}
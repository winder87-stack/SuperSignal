# Hyperliquid Super Signal - Bugs, Errors & Issues

> **Generated**: 2026-01-04  
> **Summary**: Comprehensive scan of codebase for bugs, broken code, and errors

---

## 🔴 Critical Errors (Blocking Build/Compile)

### 1. Syntax Errors in `engine.ts` - Missing Closing Parentheses

**Location**: `src/core/engine.ts`  
**Lines**: 402, 509, 1156  
**Issue**: `Promise.race` calls are missing closing parentheses, causing TypeScript compilation to fail.

```typescript
// Line 402 - BROKEN:
const entryResult = await Promise.race([
    this.client.api.placeOrder([entryOrderWire], 'na'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('placeOrder timeout')), 10000)
]);

// Should be:
const entryResult = await Promise.race([
    this.client.api.placeOrder([entryOrderWire], 'na'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('placeOrder timeout')), 10000))
]);
```

**Same issue at lines 509 and 1156** - all `Promise.race` timeout patterns are missing the final `)` before the closing `]`.

**Fix**: Add missing `)` to close the `new Promise()` constructor in each of the 3 locations.

---

## 🟠 Dashboard TypeScript Errors (12 Errors)

### 2. Untyped Data in `App.tsx`

**Location**: `dashboard/src/App.tsx`  
**Lines**: 27, 56, 64-71  
**Issue**: The `data` property from `lastMessage` has type `unknown`, causing TypeScript errors when accessing properties.

**Errors**:

- `Property 'pair' does not exist on type 'unknown'`
- `Property 'candle' does not exist on type 'unknown'`
- `Property 'status' does not exist on type 'unknown'`
- `'data' is of type 'unknown'` (8 occurrences)

**Fix**: Either define types for WebSocket messages or add type guards/assertions:

```typescript
// Option 1: Define message type interface
interface PriceUpdateData {
  pair: string;
  candle: {
    timestamp: number;
    open: string;
    high: string;
    low: string;
    close: string;
  };
}

interface PositionUpdateData {
  status: 'opened' | 'closed' | 'updated';
  pair: string;
  direction: 'long' | 'short';
  size: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number;
  timestamp: number;
  pnl?: number;
}

// Option 2: Type assertion before use
const { pair, candle } = data as PriceUpdateData;
```

---

## 🟡 ESLint Warnings

### 3. Explicit `any` Type in `rateLimiter.ts`

**Location**: `src/utils/rateLimiter.ts`  
**Line**: 78  
**Issue**: Using `(this as any).processingTimeout` triggers the `@typescript-eslint/no-explicit-any` warning.

**Current Code**:

```typescript
(this as any).processingTimeout = timeoutId;
```

**Fix**: Add a private class property with proper typing:

```typescript
class TokenBucket {
    private processingTimeout: NodeJS.Timeout | null = null;
    // ...
    private scheduleNextProcessing(): void {
        // ...
        this.processingTimeout = setTimeout(() => {
            this.processQueue();
        }, Math.max(0, timeUntilToken));
    }
}
```

---

## 🔵 Code Quality Issues

### 4. Unused State Variable `candleData`

**Location**: `dashboard/src/App.tsx`  
**Line**: 19  
**Issue**: State variable uses `any[]` type instead of proper candle type.

```typescript
const [candleData, setCandleData] = useState<Record<string, any[]>>({});
```

**Fix**: Define a proper `ChartCandle` interface:

```typescript
interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
const [candleData, setCandleData] = useState<Record<string, ChartCandle[]>>({});
```

---

## ✅ Completed Items (From Previous TODO.md)

The following items have been verified as completed:

- [x] Implement Strategy Exits in TradingEngine
- [x] Implement Trailing Stop Order Updates
- [x] Integrate Order Book Analysis
- [x] Consolidate Trading Logic
- [x] Verify Divergence Logic Continuation Check
- [x] Validate Hardcoded Trading Pairs
- [x] Add Unit Tests for TradingEngine

---

## 📋 Fix Priority Order

| Priority | File | Issue | Effort |
|----------|------|-------|--------|
| 1 | `src/core/engine.ts` | 3 missing closing parentheses | 5 min |
| 2 | `dashboard/src/App.tsx` | Add type definitions for WebSocket data | 15 min |
| 3 | `src/utils/rateLimiter.ts` | Replace `any` with proper type | 5 min |

---

## 🧪 Verification Commands

After fixes, run these to verify:

```bash
# Check TypeScript compilation
npx tsc --noEmit

# Run ESLint
npm run lint

# Build dashboard
cd dashboard && npm run build

# Run all tests
npm test
```

---

## 📝 Notes

- The `logError` method in `TradingLogger` is correctly defined and used throughout the codebase
- All 3 syntax errors in `engine.ts` are the same pattern - timeout promises in `Promise.race`
- Dashboard build completely fails due to TypeScript errors - dashboard is non-functional until fixed

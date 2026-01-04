/**
 * Custom error classes for the trading bot
 */

/**
 * Thrown when an API request times out
 */
export class TimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TimeoutError';
        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, TimeoutError);
        }
    }
}

/**
 * Thrown when an API request fails after all retries
 */
export class APIError extends Error {
    public readonly statusCode?: number;
    public readonly response?: unknown;

    constructor(message: string, statusCode?: number, response?: unknown) {
        super(message);
        this.name = 'APIError';
        this.statusCode = statusCode;
        this.response = response;

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, APIError);
        }
    }
}

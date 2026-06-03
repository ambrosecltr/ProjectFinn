import { createLogger } from "./logger.js";

const logger = createLogger("rate-limiter");

export interface RateLimiterOpts {
  /** Max requests allowed in the window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Name for logging */
  name: string;
}

export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly name: string;

  constructor(opts: RateLimiterOpts) {
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;
    this.name = opts.name;
  }

  /** Returns true if the request is allowed, false if rate-limited */
  tryAcquire(): boolean {
    const now = Date.now();
    while (this.timestamps.length > 0 && this.timestamps[0]! <= now - this.windowMs) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxRequests) {
      logger.warn(
        { name: this.name, current: this.timestamps.length, max: this.maxRequests },
        "Rate limit exceeded",
      );
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  /** Waits until a slot is available, then acquires it. Returns time waited in ms. */
  async waitForSlot(): Promise<number> {
    const start = Date.now();
    while (!this.tryAcquire()) {
      const oldest = this.timestamps[0];
      if (oldest === undefined) break;
      const waitMs = Math.max(oldest + this.windowMs - Date.now() + 10, 50);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    return Date.now() - start;
  }

  /** Reset the limiter */
  reset(): void {
    this.timestamps.length = 0;
  }
}

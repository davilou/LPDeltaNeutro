import { ethers } from 'ethers';
import { logger } from './logger';

/**
 * Wraps multiple JsonRpcProviders with automatic fallback.
 * Tries each RPC in order; on failure rotates to the next.
 */
export class FallbackProvider {
  private providers: ethers.JsonRpcProvider[];
  private currentIndex: number = 0;

  constructor(rpcUrls: string[]) {
    if (rpcUrls.length === 0) {
      throw new Error('At least one RPC URL is required');
    }
    this.providers = rpcUrls.map((url) => new ethers.JsonRpcProvider(url));
    logger.info(`FallbackProvider initialized with ${rpcUrls.length} RPCs`);
  }

  get current(): ethers.JsonRpcProvider {
    return this.providers[this.currentIndex];
  }

  private rotate(): void {
    const prev = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % this.providers.length;
    logger.warn(`RPC fallback: rotating from #${prev} to #${this.currentIndex}`);
  }

  /**
   * Execute an async operation against the provider, with fallback on failure.
   * Tries each provider once before giving up.
   */
  async call<T>(fn: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      try {
        return await fn(this.providers[this.currentIndex]);
      } catch (err) {
        lastError = err;
        logger.warn(`RPC #${this.currentIndex} failed: ${err}`);
        this.rotate();
      }
    }

    throw lastError;
  }
}

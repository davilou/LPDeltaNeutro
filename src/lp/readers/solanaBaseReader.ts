// src/lp/readers/solanaBaseReader.ts
import { Connection } from '@solana/web3.js';
import { config } from '../../config';
import type { PositionId } from '../types';

/**
 * Shared base for all Solana LP readers.
 * Manages a single @solana/web3.js Connection + a TTL cache keyed by position pubkey.
 */
export abstract class SolanaBaseReader {
  protected readonly connection: Connection;
  private readonly _cache = new Map<string, { data: unknown; ts: number }>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor() {
    this.connection = new Connection(config.solanaHttpRpcUrl, 'confirmed');
  }

  async getBlockOrSlot(): Promise<number> {
    return this.connection.getSlot();
  }

  invalidateCache(id: PositionId): void {
    this._cache.delete(String(id));
  }

  protected getCached<T>(key: string): T | undefined {
    const entry = this._cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > SolanaBaseReader.CACHE_TTL_MS) {
      this._cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  protected setCache(key: string, data: unknown): void {
    this._cache.set(key, { data, ts: Date.now() });
  }
}

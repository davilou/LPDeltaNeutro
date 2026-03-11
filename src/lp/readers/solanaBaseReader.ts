// src/lp/readers/solanaBaseReader.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../../config';
import type { PositionId } from '../types';
import { logger } from '../../utils/logger';

// Metaplex Token Metadata program
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/**
 * Shared base for all Solana LP readers.
 * Manages a single @solana/web3.js Connection + a TTL cache keyed by position pubkey.
 */
export abstract class SolanaBaseReader {
  protected readonly connection: Connection;
  private readonly _cache = new Map<string, { data: unknown; ts: number }>();
  private static readonly CACHE_TTL_MS = 30_000;

  /** Cross-instance symbol cache: shared by all readers/scanners in the same process */
  private static readonly _symbolCache = new Map<string, string>();

  constructor() {
    const rpcUrl = config.lpFreeSolRpcUrl ?? config.solanaHttpRpcUrl;
    this.connection = new Connection(rpcUrl, 'confirmed');
    logger.debug(`[SolanaBaseReader] Using RPC: ${rpcUrl}`);
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

  /**
   * Resolve token symbol for a Solana mint address.
   * 1) Metaplex Token Metadata on-chain
   * 2) DexScreener token API (covers Token-2022, unlisted, etc.)
   * 3) Fallback: first 6 chars of mint address
   */
  async resolveTokenSymbol(mint: PublicKey): Promise<string> {
    const key = mint.toBase58();
    if (SolanaBaseReader._symbolCache.has(key)) return SolanaBaseReader._symbolCache.get(key)!;

    // 1) Metaplex Token Metadata
    try {
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        METADATA_PROGRAM_ID,
      );
      const accountInfo = await this.connection.getAccountInfo(metadataPDA);
      if (accountInfo) {
        const data = accountInfo.data;
        let offset = 1 + 32 + 32; // key + update_authority + mint
        const nameLen = data.readUInt32LE(offset); offset += 4 + nameLen;
        const symbolLen = data.readUInt32LE(offset); offset += 4;
        const symbol = data
          .subarray(offset, offset + symbolLen)
          .toString('utf8')
          .replace(/\0/g, '')
          .trim();
        if (symbol) {
          logger.debug(`[SolanaSymbol] ${key} → "${symbol}" (metaplex)`);
          SolanaBaseReader._symbolCache.set(key, symbol);
          return symbol;
        }
      }
      logger.debug(`[SolanaSymbol] ${key}: metaplex PDA ${accountInfo ? 'empty symbol' : 'not found'}`);
    } catch (err) {
      logger.debug(`[SolanaSymbol] ${key}: metaplex error: ${err}`);
    }

    // 2) DexScreener token lookup
    try {
      const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${key}`);
      if (resp.ok) {
        const json = await resp.json() as { pairs?: Array<{ baseToken?: { address?: string; symbol?: string }; quoteToken?: { address?: string; symbol?: string } }> };
        if (json.pairs && json.pairs.length > 0) {
          for (const pair of json.pairs) {
            if (pair.baseToken?.address === key && pair.baseToken.symbol) {
              logger.debug(`[SolanaSymbol] ${key} → "${pair.baseToken.symbol}" (dexscreener baseToken)`);
              SolanaBaseReader._symbolCache.set(key, pair.baseToken.symbol);
              return pair.baseToken.symbol;
            }
            if (pair.quoteToken?.address === key && pair.quoteToken.symbol) {
              logger.debug(`[SolanaSymbol] ${key} → "${pair.quoteToken.symbol}" (dexscreener quoteToken)`);
              SolanaBaseReader._symbolCache.set(key, pair.quoteToken.symbol);
              return pair.quoteToken.symbol;
            }
          }
        }
      }
      logger.debug(`[SolanaSymbol] ${key}: dexscreener returned no matching pairs`);
    } catch (err) {
      logger.debug(`[SolanaSymbol] ${key}: dexscreener error: ${err}`);
    }

    logger.warn(`[SolanaSymbol] Could not resolve symbol for mint ${key} — using address prefix`);
    const fallback = key.slice(0, 6);
    SolanaBaseReader._symbolCache.set(key, fallback);
    return fallback;
  }

  /** Access the static symbol cache (e.g. from scanner) */
  static getSymbolCache(): Map<string, string> {
    return SolanaBaseReader._symbolCache;
  }
}

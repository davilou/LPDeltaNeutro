import { ChainId, DexId, ILPReader } from './types';
import { EvmClReader } from './readers/evmClReader';
import { EvmV4Reader } from './readers/evmV4Reader';
import { SolanaReader } from './readers/solanaReader';
import { isChainDexSupported } from './chainRegistry';

const V4_DEXES = new Set<DexId>(['uniswap-v4', 'pancake-v4']);
const SOLANA_CHAINS = new Set<ChainId>(['solana']);

/**
 * Returns an ILPReader for the given chain/dex combination.
 * Throws if the combination is not in the chain registry.
 */
export function createLPReader(chain: ChainId, dex: DexId): ILPReader {
  if (SOLANA_CHAINS.has(chain)) {
    return new SolanaReader();
  }

  if (!isChainDexSupported(chain, dex)) {
    throw new Error(`Unsupported chain/dex combination: ${chain}:${dex}. Check chainRegistry.ts.`);
  }

  if (V4_DEXES.has(dex)) {
    return new EvmV4Reader(chain, dex);
  }

  return new EvmClReader(chain, dex);
}

import { ChainId, DexId, IWalletScanner } from './types';
import { EvmScanner } from './scanners/evmScanner';
import { SolanaScanner } from './scanners/solanaScanner';

const SOLANA_CHAINS = new Set<ChainId>(['solana']);

/**
 * Returns an IWalletScanner for the given chain/dex combination.
 */
export function createWalletScanner(chain: ChainId, dex: DexId): IWalletScanner {
  if (SOLANA_CHAINS.has(chain)) {
    return new SolanaScanner(dex);
  }
  return new EvmScanner(chain, dex);
}

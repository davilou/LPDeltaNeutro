import type { DiscoveredPosition } from '../../types';
import type { IWalletScanner, PositionId } from '../types';

export class SolanaScanner implements IWalletScanner {
  scanWallet(_address: string): Promise<DiscoveredPosition[]> {
    throw new Error('SolanaScanner: not yet implemented (Phase 2)');
  }
  lookupById(_id: PositionId): Promise<DiscoveredPosition | null> {
    throw new Error('SolanaScanner: not yet implemented (Phase 2)');
  }
}

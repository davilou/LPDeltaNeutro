import type { LPPosition } from '../../types';
import type { ILPReader, PositionId } from '../types';

/**
 * Phase 2 stub — Solana LP reader (Orca, Raydium, Meteora).
 * Throws until Phase 2 is implemented.
 */
export class SolanaReader implements ILPReader {
  readPosition(_id: PositionId, _poolAddress: string): Promise<LPPosition> {
    throw new Error('SolanaReader: not yet implemented (Phase 2)');
  }
  invalidateCache(_id: PositionId): void { /* noop */ }
  getBlockOrSlot(): Promise<number> {
    throw new Error('SolanaReader: not yet implemented (Phase 2)');
  }
}

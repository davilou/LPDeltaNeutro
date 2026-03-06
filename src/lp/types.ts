import type { LPPosition, DiscoveredPosition } from '../types';

export type ChainId =
  | 'base'
  | 'eth'
  | 'bsc'
  | 'arbitrum'
  | 'polygon'
  | 'avalanche'
  | 'hyperliquid-l1'
  | 'solana'; // Phase 2

export type DexId =
  | 'uniswap-v3'
  | 'uniswap-v4'
  | 'pancake-v3'
  | 'pancake-v4'
  | 'aerodrome-cl'
  | 'project-x';   // HL L1

/** EVM: NFT tokenId (number). Solana phase 2: position pubkey (string). */
export type PositionId = number | string;

export interface ILPReader {
  readPosition(id: PositionId, poolAddress: string): Promise<LPPosition>;
  invalidateCache(id: PositionId): void;
  getBlockOrSlot(): Promise<number>;
}

export interface IWalletScanner {
  scanWallet(address: string): Promise<DiscoveredPosition[]>;
  lookupById(id: PositionId): Promise<DiscoveredPosition | null>;
}

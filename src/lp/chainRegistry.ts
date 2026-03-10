import { ChainId, DexId } from './types';

export interface ChainDexAddresses {
  positionManagerV3?: string;
  factoryV3?: string;
  initCodeHashV3?: string;
  positionManagerV4?: string;
  poolManagerV4?: string;
  stateViewV4?: string;
}

// Multicall3 is deployed at the same address on all supported EVMs
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

type RegistryKey = `${ChainId}:${DexId}`;

const REGISTRY: Partial<Record<RegistryKey, ChainDexAddresses>> = {
  // ── BASE ────────────────────────────────────────────────────────────────
  'base:uniswap-v3': {
    positionManagerV3: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    factoryV3:         '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },
  'base:uniswap-v4': {
    positionManagerV4: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
    poolManagerV4:     '0x498581ff718922c3f8e6a244956af099b2652b2b',
    stateViewV4:       '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
  },
  'base:aerodrome-cl': {
    positionManagerV3: '0x827922686190790b37229fd06084350e74485b72',
    factoryV3:         '0x5e7BB104d84c7CB9B682AaC2F3d509f890406f6d',
    initCodeHashV3:    '0x1565b129f2d1790f12d45301b9b084335626f0c92410bc43130763b69971135d',
  },

  // ── ETHEREUM MAINNET ────────────────────────────────────────────────────
  'eth:uniswap-v3': {
    positionManagerV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factoryV3:         '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },
  'eth:uniswap-v4': {
    positionManagerV4: '0x7c0f70bff9b6ad84e2ac21d4dc74fb4a5fff86ce',
    poolManagerV4:     '0x000000000004444c5dc75cB358380D2e3dE08A90',
    stateViewV4:       '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  },
  'eth:pancake-v3': {
    positionManagerV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factoryV3:         '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    initCodeHashV3:    '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
  },
  // PancakeSwap V4 on ETH — addresses TBD, add when verified
  // 'eth:pancake-v4': { ... },

  // ── BSC ─────────────────────────────────────────────────────────────────
  'bsc:uniswap-v3': {
    positionManagerV3: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
    factoryV3:         '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
    // initCodeHashV3 omitted: BSC Uniswap V3 is unofficial, bytecode hash differs → use factory.getPool()
  },
  'bsc:uniswap-v4': {
    positionManagerV4: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b',
    poolManagerV4:     '0x28e2ea090877bf75740558f6bfb36a5ffeeb8e97',
    stateViewV4:       '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4',
  },
  'bsc:pancake-v3': {
    positionManagerV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factoryV3:         '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    initCodeHashV3:    '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
  },
  // PancakeSwap V4 on BSC — addresses TBD, add when verified
  // 'bsc:pancake-v4': { ... },

  // ── ARBITRUM ────────────────────────────────────────────────────────────
  'arbitrum:uniswap-v3': {
    positionManagerV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factoryV3:         '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },
  'arbitrum:uniswap-v4': {
    positionManagerV4: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
    poolManagerV4:     '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32',
    stateViewV4:       '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
  },
  'arbitrum:pancake-v3': {
    positionManagerV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factoryV3:         '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    initCodeHashV3:    '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
  },

  // ── POLYGON ─────────────────────────────────────────────────────────────
  'polygon:uniswap-v3': {
    positionManagerV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factoryV3:         '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    initCodeHashV3:    '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  },
  'polygon:uniswap-v4': {
    positionManagerV4: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
    poolManagerV4:     '0x67366782805870060151383f4bbff9b05df34e60',
    stateViewV4:       '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a',
  },
  'polygon:pancake-v3': {
    positionManagerV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factoryV3:         '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    initCodeHashV3:    '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
  },

  // ── AVALANCHE ───────────────────────────────────────────────────────────
  'avalanche:uniswap-v3': {
    positionManagerV3: '0x655C406EBFa14EE2006250925e54ec43AD184f8B',
    factoryV3:         '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
    // initCodeHashV3 omitted: Avalanche Uniswap V3 is unofficial, bytecode hash differs → use factory.getPool()
  },
  'avalanche:uniswap-v4': {
    positionManagerV4: '0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd',
    poolManagerV4:     '0x06380c0a08aa5b7fa2e2dfc4063ccbd68cdce3ca',
    stateViewV4:       '0xc3c9e198c735a4b97e3e683f391ccbdd60b69286',
  },

  // ── HYPERLIQUID L1 (HyperEVM, chain ID 999) ─────────────────────────────
  // ProjectX — NonfungiblePositionManager is Uniswap V3-compatible
  'hyperliquid-l1:project-x': {
    positionManagerV3: '0xeaD19AE861c29bBb2101E834922B2FEee69B9091',
    factoryV3:         '0xeAF40318453a81993569B14b898AAC31Df6133fA',
    // initCodeHashV3 not published — pool address resolved via factory.getPool()
  },
};

export function getChainDexAddresses(chain: ChainId, dex: DexId): ChainDexAddresses {
  const key: RegistryKey = `${chain}:${dex}`;
  const config = REGISTRY[key];
  if (!config) {
    throw new Error(`No registry entry for chain=${chain} dex=${dex}. Add addresses to chainRegistry.ts.`);
  }
  return config;
}

export function isChainDexSupported(chain: ChainId, dex: DexId): boolean {
  return `${chain}:${dex}` in REGISTRY;
}

/** Returns all supported (chain, dex) pairs. */
export function listSupportedPairs(): Array<{ chain: ChainId; dex: DexId }> {
  return (Object.keys(REGISTRY) as RegistryKey[]).map(key => {
    const [chain, dex] = key.split(':') as [ChainId, DexId];
    return { chain, dex };
  });
}

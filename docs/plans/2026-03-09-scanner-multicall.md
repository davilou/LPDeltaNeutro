# Scanner Rewrite — Multicall3 (V3) + Transfer Events (V4)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite `EvmScanner` so V3 wallet scan uses Multicall3 (≤5 RPC calls total vs. O(n)) and V4 scan uses ERC721 Transfer events + Multicall3 batching — both work reliably on public free RPCs.

**Architecture:** `scanV3()` is replaced to batch all calls through `multicall3()` in 5 sequential rounds (balanceOf → tokenIds → positionData → tokenInfo+pools → slot0). `scanV4()` is added as a new private method: fetch Transfer logs filtered by wallet address, then batch `getPositionLiquidity + getPoolAndPositionInfo` + token info + slot0 via multicall3. `scanWallet()` calls the appropriate method based on `dex` (V4 dexes → `scanV4`, rest → `scanV3`). `lookupById` for V4 dexes is also added.

**Tech Stack:** Node.js + TypeScript strict + ethers.js v6 + `src/utils/multicall.ts` (`multicall3`, `buildCall3`, `decodeCall3Result`) + `getLpProvider(chain)`

---

### Task 1: scanV3() — Multicall3 rewrite

**Files:**
- Modify: `src/lp/scanners/evmScanner.ts`

The problem: current `scanV3()` sends one RPC call per tokenId for `tokenOfOwnerByIndex`, then one per pair for `positions()`, then sequential calls for token info and pool resolution — totaling O(n) RPC round trips, which rate-limits on free RPCs.

**Step 1: Add multicall3 import at top of evmScanner.ts**

After the existing imports (around line 8), add:

```typescript
import { multicall3, buildCall3, decodeCall3Result } from '../../utils/multicall';
```

**Step 2: Replace scanV3() entirely**

Replace the existing `private async scanV3(walletAddress: string)` method (lines 99–175) with the following implementation.

Important context:
- `getLpProvider(this.chain)` returns a `FallbackProvider` with a `.call(fn)` method that passes an `ethers.Provider` to `fn` and retries on failure
- `multicall3(provider, calls)` executes all calls in a single `eth_call` via the Multicall3 contract
- `buildCall3(contract, method, args)` encodes a call for multicall3
- `decodeCall3Result<T>(contract, method, result)` decodes the returned bytes; returns `null` if the call failed (allowFailure=true)
- The `positions()` ABI has named fields: nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, ...

```typescript
private async scanV3(walletAddress: string): Promise<DiscoveredPosition[]> {
  const addresses = getChainDexAddresses(this.chain, this.dex);
  if (!addresses.positionManagerV3) return [];
  const fallback = getLpProvider(this.chain);

  // Round 1: balanceOf — 1 RPC call
  const balance: bigint = await fallback.call(async (p) => {
    const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
    return pm.balanceOf(walletAddress);
  });
  const count = Number(balance);
  if (count === 0) return [];

  logger.info(`[EvmScanner][${this.chain}:${this.dex}] ${walletAddress} owns ${count} NFTs`);

  // Round 2: tokenOfOwnerByIndex[0..n-1] — 1 multicall
  const tokenIds: bigint[] = await fallback.call(async (p) => {
    const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
    const calls = Array.from({ length: count }, (_, i) =>
      buildCall3(pm, 'tokenOfOwnerByIndex', [walletAddress, i]),
    );
    const results = await multicall3(p, calls);
    return results
      .map(r => decodeCall3Result<bigint>(pm, 'tokenOfOwnerByIndex', r))
      .filter((v): v is bigint => v !== null);
  });

  // Round 3: positions(tokenId) for all tokenIds — 1 multicall
  interface PosData {
    tokenId: bigint;
    token0: string;
    token1: string;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
  }
  const livePositions: PosData[] = await fallback.call(async (p) => {
    const pm = new ethers.Contract(addresses.positionManagerV3!, POSITION_MANAGER_V3_ABI, p);
    const calls = tokenIds.map(id => buildCall3(pm, 'positions', [id]));
    const results = await multicall3(p, calls);
    const out: PosData[] = [];
    for (let i = 0; i < tokenIds.length; i++) {
      const raw = decodeCall3Result<ethers.Result>(pm, 'positions', results[i]);
      if (!raw) continue;
      const liquidity = BigInt(raw.liquidity);
      if (liquidity === 0n) continue;
      out.push({
        tokenId: tokenIds[i],
        token0: String(raw.token0).toLowerCase(),
        token1: String(raw.token1).toLowerCase(),
        fee: Number(raw.fee),
        tickLower: Number(raw.tickLower),
        tickUpper: Number(raw.tickUpper),
        liquidity,
      });
    }
    return out;
  });

  if (livePositions.length === 0) return [];

  // Round 4: token ERC20 info for unknown tokens + factory.getPool for unique pools — 1 multicall
  const tokenAddrs = new Set<string>();
  for (const p of livePositions) { tokenAddrs.add(p.token0); tokenAddrs.add(p.token1); }
  const unknownTokens = [...tokenAddrs].filter(a => !getTokenCache(this.chain).has(a));

  // Unique (t0, t1, fee) pool tuples — use canonical ordering
  type PoolKey = `${string}:${string}:${number}`;
  const poolKeyMap = new Map<PoolKey, { t0: string; t1: string; fee: number }>();
  for (const p of livePositions) {
    const [tA, tB] = p.token0 < p.token1 ? [p.token0, p.token1] : [p.token1, p.token0];
    const key: PoolKey = `${tA}:${tB}:${p.fee}`;
    if (!poolKeyMap.has(key)) poolKeyMap.set(key, { t0: tA, t1: tB, fee: p.fee });
  }

  const poolAddrs = new Map<PoolKey, string>(); // key → pool address
  await fallback.call(async (p) => {
    const erc20 = new ethers.Contract(ethers.ZeroAddress, ERC20_ABI, p);
    const tokenCalls = unknownTokens.flatMap(addr => {
      const c = new ethers.Contract(addr, ERC20_ABI, p);
      return [
        buildCall3(c, 'symbol', []),
        buildCall3(c, 'decimals', []),
      ];
    });

    // Factory calls — use CREATE2 if initCodeHash available, else call factory
    const poolKeys = [...poolKeyMap.entries()];
    const factoryCalls: Array<{ key: PoolKey; callIdx: number } | null> = [];
    let tokenCallCount = tokenCalls.length;
    const extraCalls: ReturnType<typeof buildCall3>[] = [];

    for (const [key, { t0, t1, fee }] of poolKeys) {
      if (addresses.initCodeHashV3 && addresses.factoryV3) {
        // CREATE2 derivation — no RPC needed
        const salt = ethers.solidityPackedKeccak256(['address', 'address', 'uint24'], [t0, t1, fee]);
        poolAddrs.set(key, ethers.getCreate2Address(addresses.factoryV3, salt, addresses.initCodeHashV3));
        factoryCalls.push(null);
      } else if (addresses.factoryV3) {
        const factory = new ethers.Contract(addresses.factoryV3, FACTORY_V3_ABI, p);
        extraCalls.push(buildCall3(factory, 'getPool', [t0, t1, fee]));
        factoryCalls.push({ key, callIdx: tokenCallCount + extraCalls.length - 1 });
      } else {
        factoryCalls.push(null);
      }
    }

    const allCalls = [...tokenCalls, ...extraCalls];
    const results = allCalls.length > 0 ? await multicall3(p, allCalls) : [];

    // Parse token info
    const cache = getTokenCache(this.chain);
    for (let i = 0; i < unknownTokens.length; i++) {
      const symResult = results[i * 2];
      const decResult = results[i * 2 + 1];
      const sym = decodeCall3Result<string>(new ethers.Contract(unknownTokens[i], ERC20_ABI, p), 'symbol', symResult);
      const dec = decodeCall3Result<bigint>(new ethers.Contract(unknownTokens[i], ERC20_ABI, p), 'decimals', decResult);
      cache.set(unknownTokens[i], {
        symbol: sym ?? 'UNKNOWN',
        decimals: dec !== null ? Number(dec) : 18,
      });
    }

    // Parse pool addresses from factory calls
    for (let i = 0; i < factoryCalls.length; i++) {
      const fc = factoryCalls[i];
      if (!fc) continue;
      const { key } = fc;
      const { t0, t1, fee } = poolKeyMap.get(key)!;
      const factory = new ethers.Contract(addresses.factoryV3!, FACTORY_V3_ABI, p);
      const addr = decodeCall3Result<string>(factory, 'getPool', results[fc.callIdx]);
      if (addr && addr !== ethers.ZeroAddress) {
        poolAddrs.set(key, addr);
      }
    }
  });

  // Get canonical pool address for a position
  const getPoolAddr = (pos: PosData): string | null => {
    const [tA, tB] = pos.token0 < pos.token1 ? [pos.token0, pos.token1] : [pos.token1, pos.token0];
    const key: PoolKey = `${tA}:${tB}:${pos.fee}`;
    return poolAddrs.get(key) ?? null;
  };

  // Filter positions where pool address was resolved
  const positionsWithPools = livePositions.filter(pos => getPoolAddr(pos) !== null);
  if (positionsWithPools.length === 0) return [];

  // Round 5: slot0 for all live pools — 1 multicall
  const uniquePoolAddrs = [...new Set(positionsWithPools.map(pos => getPoolAddr(pos)!))];
  const tickByPool = new Map<string, number>();
  await fallback.call(async (p) => {
    const calls = uniquePoolAddrs.map(addr => {
      const pool = new ethers.Contract(addr, POOL_V3_ABI, p);
      return buildCall3(pool, 'slot0', []);
    });
    const results = await multicall3(p, calls);
    for (let i = 0; i < uniquePoolAddrs.length; i++) {
      const pool = new ethers.Contract(uniquePoolAddrs[i], POOL_V3_ABI, p);
      const decoded = decodeCall3Result<ethers.Result>(pool, 'slot0', results[i]);
      if (decoded) tickByPool.set(uniquePoolAddrs[i], Number(decoded.tick));
    }
  });

  // Build DiscoveredPosition list
  const cache = getTokenCache(this.chain);
  const discovered: DiscoveredPosition[] = [];
  for (const pos of positionsWithPools) {
    const poolAddr = getPoolAddr(pos)!;
    const tickCurrent = tickByPool.get(poolAddr);
    if (tickCurrent === undefined) continue;
    const t0 = cache.get(pos.token0) ?? { symbol: 'UNKNOWN', decimals: 18 };
    const t1 = cache.get(pos.token1) ?? { symbol: 'UNKNOWN', decimals: 18 };
    const dp = this.buildDiscoveredPosition(
      Number(pos.tokenId), pos.token0, t0, pos.token1, t1, pos.fee,
      pos.tickLower, pos.tickUpper, tickCurrent, pos.liquidity, poolAddr,
    );
    if (dp.estimatedUsd >= 10 || dp.estimatedUsd === 0) discovered.push(dp);
  }
  logger.info(`[EvmScanner][${this.chain}:${this.dex}] Found ${discovered.length} active positions (${count} NFTs total)`);
  return discovered;
}
```

**Step 3: Verify build**

```bash
npx tsc --noEmit
```

Expected: zero errors. If `ethers.Result` is not recognized, use `any` as intermediate type (e.g., `decodeCall3Result<any>`) — but keep the outer typing strict.

**Step 4: Commit**

```bash
git add src/lp/scanners/evmScanner.ts
git commit -m "feat(scanner): rewrite scanV3 with multicall3 — O(n) RPC calls → 5 round trips"
```

---

### Task 2: scanV4() — Transfer events + Multicall3

**Files:**
- Modify: `src/lp/scanners/evmScanner.ts`

The V4 PositionManager is ERC721 but NOT ERC721Enumerable (no `tokenOfOwnerByIndex`). Instead we scan `Transfer` events filtered by `to = wallet` to discover all tokenIds, then batch position data via multicall3.

V4 ABI context:
- `getPoolAndPositionInfo(tokenId)` → `(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 info)` — `info` is a packed bytes32: bits 8–31 = tickLower (24-bit signed), bits 32–55 = tickUpper (24-bit signed)
- `getPositionLiquidity(tokenId)` → `uint128 liquidity`
- `StateView.getSlot0(poolId)` → `(uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)`
- poolId = `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`

**Step 1: Add V4 ABIs near the top of evmScanner.ts** (after the existing ABI constants):

```typescript
const POSITION_MANAGER_V4_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

const STATE_VIEW_V4_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];
```

**Step 2: Add `scanV4()` private method** (add after `scanV3()`):

```typescript
private async scanV4(walletAddress: string): Promise<DiscoveredPosition[]> {
  const addresses = getChainDexAddresses(this.chain, this.dex);
  if (!addresses.positionManagerV4 || !addresses.stateViewV4) return [];
  const fallback = getLpProvider(this.chain);
  const pmAddr = addresses.positionManagerV4;
  const svAddr = addresses.stateViewV4;

  // Round 1: ERC721 Transfer events where to = wallet — eth_getLogs
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const paddedWallet = ethers.zeroPadValue(walletAddress.toLowerCase(), 32);

  const logs = await fallback.call(async (p) =>
    p.getLogs({
      address: pmAddr,
      topics: [transferTopic, null, paddedWallet],
      fromBlock: 0,
      toBlock: 'latest',
    })
  );

  // Collect unique tokenIds from Transfer-in events
  const pmIface = new ethers.Interface(POSITION_MANAGER_V4_ABI);
  const tokenIdSet = new Set<number>();
  for (const log of logs) {
    try {
      const parsed = pmIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === 'Transfer') tokenIdSet.add(Number(parsed.args.tokenId));
    } catch { /* ignore unparseable logs */ }
  }

  const tokenIds = [...tokenIdSet];
  if (tokenIds.length === 0) return [];
  logger.info(`[EvmScanner][${this.chain}:${this.dex}] Found ${tokenIds.length} Transfer-in events for ${walletAddress}`);

  // Round 2: batch getPositionLiquidity + getPoolAndPositionInfo — 1 multicall
  interface V4PosData {
    tokenId: number;
    currency0: string;
    currency1: string;
    fee: number;
    tickSpacing: number;
    hooks: string;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    poolId: string;
  }

  const livePositions: V4PosData[] = await fallback.call(async (p) => {
    const pm = new ethers.Contract(pmAddr, POSITION_MANAGER_V4_ABI, p);
    const calls = tokenIds.flatMap(id => [
      buildCall3(pm, 'getPositionLiquidity', [id]),
      buildCall3(pm, 'getPoolAndPositionInfo', [id]),
    ]);
    const results = await multicall3(p, calls);
    const out: V4PosData[] = [];

    for (let i = 0; i < tokenIds.length; i++) {
      const liquidityResult = results[i * 2];
      const infoResult = results[i * 2 + 1];
      if (!liquidityResult.success || !infoResult.success) continue;

      const liquidity = BigInt(
        pm.interface.decodeFunctionResult('getPositionLiquidity', liquidityResult.returnData)[0],
      );
      if (liquidity === 0n) continue;

      const decoded = pm.interface.decodeFunctionResult('getPoolAndPositionInfo', infoResult.returnData);
      const poolKey = decoded[0];
      const infoBig = BigInt(decoded[1]);

      const rawTickLower = Number((infoBig >> 8n) & 0xFFFFFFn);
      const tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
      const rawTickUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
      const tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

      const poolId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'address', 'uint24', 'int24', 'address'],
          [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
        )
      );

      out.push({
        tokenId: tokenIds[i],
        currency0: String(poolKey.currency0).toLowerCase(),
        currency1: String(poolKey.currency1).toLowerCase(),
        fee: Number(poolKey.fee),
        tickSpacing: Number(poolKey.tickSpacing),
        hooks: String(poolKey.hooks),
        tickLower,
        tickUpper,
        liquidity,
        poolId,
      });
    }
    return out;
  });

  if (livePositions.length === 0) return [];

  // Round 3: token info for unknown tokens + slot0 for unique pools — 1 multicall
  const tokenAddrs = new Set<string>();
  for (const p of livePositions) { tokenAddrs.add(p.currency0); tokenAddrs.add(p.currency1); }
  const unknownTokens = [...tokenAddrs].filter(a => !getTokenCache(this.chain).has(a));
  const uniquePoolIds = [...new Set(livePositions.map(p => p.poolId))];

  const tickByPool = new Map<string, number>();
  await fallback.call(async (p) => {
    const sv = new ethers.Contract(svAddr, STATE_VIEW_V4_ABI, p);
    const tokenCalls = unknownTokens.flatMap(addr => {
      const c = new ethers.Contract(addr, ERC20_ABI, p);
      return [buildCall3(c, 'symbol', []), buildCall3(c, 'decimals', [])];
    });
    const slotCalls = uniquePoolIds.map(poolId => buildCall3(sv, 'getSlot0', [poolId]));
    const allCalls = [...tokenCalls, ...slotCalls];
    const results = await multicall3(p, allCalls);

    // Parse token info
    const cache = getTokenCache(this.chain);
    for (let i = 0; i < unknownTokens.length; i++) {
      const c = new ethers.Contract(unknownTokens[i], ERC20_ABI, p);
      const sym = decodeCall3Result<string>(c, 'symbol', results[i * 2]);
      const dec = decodeCall3Result<bigint>(c, 'decimals', results[i * 2 + 1]);
      cache.set(unknownTokens[i], { symbol: sym ?? 'UNKNOWN', decimals: dec !== null ? Number(dec) : 18 });
    }

    // Parse slot0
    for (let i = 0; i < uniquePoolIds.length; i++) {
      const r = results[tokenCalls.length + i];
      if (!r.success) continue;
      const decoded = sv.interface.decodeFunctionResult('getSlot0', r.returnData);
      tickByPool.set(uniquePoolIds[i], Number(decoded.tick));
    }
  });

  // Build DiscoveredPosition list
  const tokenCache = getTokenCache(this.chain);
  const discovered: DiscoveredPosition[] = [];
  for (const pos of livePositions) {
    const tickCurrent = tickByPool.get(pos.poolId);
    if (tickCurrent === undefined) continue;
    const t0 = tokenCache.get(pos.currency0) ?? { symbol: 'UNKNOWN', decimals: 18 };
    const t1 = tokenCache.get(pos.currency1) ?? { symbol: 'UNKNOWN', decimals: 18 };
    const dp = this.buildDiscoveredPosition(
      pos.tokenId, pos.currency0, t0, pos.currency1, t1, pos.fee,
      pos.tickLower, pos.tickUpper, tickCurrent, pos.liquidity, pos.poolId,
    );
    if (dp.estimatedUsd >= 10 || dp.estimatedUsd === 0) discovered.push(dp);
  }
  logger.info(`[EvmScanner][${this.chain}:${this.dex}] Found ${discovered.length} active V4 positions`);
  return discovered;
}
```

**Step 3: Update `scanWallet()` to route V4 dexes to `scanV4()`**

Replace:
```typescript
async scanWallet(walletAddress: string): Promise<DiscoveredPosition[]> {
  return this.scanV3(walletAddress);
}
```

With:
```typescript
async scanWallet(walletAddress: string): Promise<DiscoveredPosition[]> {
  if (this.dex === 'uniswap-v4' || this.dex === 'pancake-v4') {
    return this.scanV4(walletAddress);
  }
  return this.scanV3(walletAddress);
}
```

**Step 4: Add `lookupById` for V4 dexes**

Replace the current `lookupById` method:
```typescript
async lookupById(id: PositionId): Promise<DiscoveredPosition | null> {
  return this.lookupByTokenId(Number(id));
}
```

With:
```typescript
async lookupById(id: PositionId): Promise<DiscoveredPosition | null> {
  if (this.dex === 'uniswap-v4' || this.dex === 'pancake-v4') {
    return this.lookupByTokenIdV4(Number(id));
  }
  return this.lookupByTokenId(Number(id));
}
```

And add the V4 lookup method (add after `lookupByTokenId`):

```typescript
private async lookupByTokenIdV4(tokenId: number): Promise<DiscoveredPosition | null> {
  const addresses = getChainDexAddresses(this.chain, this.dex);
  if (!addresses.positionManagerV4 || !addresses.stateViewV4) return null;
  const fallback = getLpProvider(this.chain);

  try {
    return await fallback.call(async (p) => {
      const pm = new ethers.Contract(addresses.positionManagerV4!, POSITION_MANAGER_V4_ABI, p);
      const sv = new ethers.Contract(addresses.stateViewV4!, STATE_VIEW_V4_ABI, p);

      const liquidity: bigint = BigInt(await pm.getPositionLiquidity(tokenId));
      if (liquidity === 0n) return null;

      const { poolKey, info } = await pm.getPoolAndPositionInfo(tokenId);
      const infoBig = BigInt(info as string);
      const rawTickLower = Number((infoBig >> 8n) & 0xFFFFFFn);
      const tickLower = rawTickLower > 0x7FFFFFn ? rawTickLower - 0x1000000 : rawTickLower;
      const rawTickUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
      const tickUpper = rawTickUpper > 0x7FFFFFn ? rawTickUpper - 0x1000000 : rawTickUpper;

      const poolId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'address', 'uint24', 'int24', 'address'],
          [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
        )
      );

      const [t0Info, t1Info, slot0] = await Promise.all([
        this.getTokenInfo(p, poolKey.currency0),
        this.getTokenInfo(p, poolKey.currency1),
        sv.getSlot0(poolId),
      ]);

      const tickCurrent = Number(slot0.tick);
      const dp = this.buildDiscoveredPosition(
        tokenId,
        String(poolKey.currency0).toLowerCase(), t0Info,
        String(poolKey.currency1).toLowerCase(), t1Info,
        Number(poolKey.fee),
        tickLower, tickUpper, tickCurrent,
        liquidity, poolId,
      );
      logger.info(`[EvmScanner][${this.chain}:${this.dex}] lookupByIdV4 #${tokenId}: ${t0Info.symbol}/${t1Info.symbol}`);
      return dp;
    });
  } catch (err) {
    logger.info(`[EvmScanner][${this.chain}:${this.dex}] lookupByIdV4 #${tokenId} failed: ${err}`);
    return null;
  }
}
```

**Step 5: Verify build**

```bash
npx tsc --noEmit
```

Expected: zero errors.

**Step 6: Commit**

```bash
git add src/lp/scanners/evmScanner.ts
git commit -m "feat(scanner): add scanV4 via Transfer events + multicall3; route V4 dexes in scanWallet/lookupById"
```

---

### Task 3: Final verification

**Files:**
- No changes needed

**Step 1: Full build**

```bash
npm run build
```

Expected: compiles to `dist/` with zero errors.

**Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

**Step 3: Manual smoke test (optional if server available)**

If the bot is running, trigger a wallet scan via the dashboard (SETTINGS → scan wallet). Check logs:
```
[EvmScanner][base:uniswap-v3] 0x... owns N NFTs
[EvmScanner][base:uniswap-v3] Found M active positions (N NFTs total)
```

Verify no "rate limit" or "too many requests" errors in the logs.

**Step 4: Commit CLAUDE.md if needed**

If anything material was learned (e.g., V4 Transfer event approach confirmed working), update `CLAUDE.md` under `## Limitações conhecidas`:
```markdown
- `EvmScanner.scanV3()` uses Multicall3 — ≤5 RPC calls total regardless of NFT count
- `EvmScanner.scanV4()` uses ERC721 Transfer events on PositionManager + Multicall3 — works with public RPCs
```

```bash
git add CLAUDE.md
git commit -m "docs: document scanner multicall approach in CLAUDE.md"
```

import { ethers } from 'ethers';
import { MULTICALL3_ADDRESS } from '../lp/chainRegistry';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] results)',
];

export interface Call3 {
  target: string;
  allowFailure: boolean;
  callData: string;
}

export interface Call3Result {
  success: boolean;
  returnData: string;
}

/**
 * Execute multiple eth_call-s in a single RPC request via Multicall3.
 */
export async function multicall3(
  provider: ethers.Provider,
  calls: Call3[],
): Promise<Call3Result[]> {
  if (calls.length === 0) return [];

  const contract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  const raw = await contract.aggregate3(calls);
  return (raw as Array<{ success: boolean; returnData: string }>).map(r => ({
    success: r.success,
    returnData: r.returnData,
  }));
}

/**
 * Build a Call3 entry for a contract method call.
 * Usage: buildCall3(myContract, 'positions', [tokenId])
 */
export function buildCall3(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  allowFailure = true,
): Call3 {
  return {
    target: contract.target as string,
    allowFailure,
    callData: contract.interface.encodeFunctionData(method, args),
  };
}

/**
 * Decode a Call3Result using a contract interface.
 * Returns null if the call failed and allowFailure was true.
 */
export function decodeCall3Result<T>(
  contract: ethers.Contract,
  method: string,
  result: Call3Result,
): T | null {
  if (!result.success) return null;
  // Calling a non-existent contract returns success=true with empty returnData.
  if (!result.returnData || result.returnData === '0x') return null;
  try {
    const decoded = contract.interface.decodeFunctionResult(method, result.returnData);
    return decoded.length === 1 ? (decoded[0] as T) : (decoded as unknown as T);
  } catch {
    return null;
  }
}

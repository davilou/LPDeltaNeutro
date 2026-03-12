import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface LogContext {
  userId?: string;
  correlationId?: string;
  tokenId?: number | string;
  chain?: string;
  dex?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

/**
 * Execute `fn` within a log context. Merges with parent context if nested.
 * Cleanup is automatic when the promise resolves.
 */
export function withContext<T>(ctx: Partial<LogContext>, fn: () => T | Promise<T>): T | Promise<T> {
  const parent = asyncLocalStorage.getStore() ?? {};
  const merged: LogContext = { ...parent, ...ctx };
  return asyncLocalStorage.run(merged, fn);
}

/**
 * Returns the current async context or empty object if none.
 */
export function getLogContext(): LogContext {
  return asyncLocalStorage.getStore() ?? {};
}

/**
 * Generate a short correlation ID with optional prefix.
 * Example: generateCorrelationId('reb') → 'reb_a1b2c3d4'
 */
export function generateCorrelationId(prefix = 'op'): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

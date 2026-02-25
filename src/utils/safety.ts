import { config } from '../config';
import { logger } from './logger';

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkMinNotional(changeUsd: number): SafetyCheckResult {
  if (Math.abs(changeUsd) < config.minNotionalUsd) {
    const reason = `Change $${Math.abs(changeUsd).toFixed(2)} below min notional $${config.minNotionalUsd}`;
    logger.info(`[SAFETY] BLOCKED: ${reason}`);
    return { allowed: false, reason };
  }
  return { allowed: true };
}

export function checkMaxNotional(totalUsd: number): SafetyCheckResult {
  if (totalUsd > config.maxNotionalUsd) {
    const reason = `Total notional $${totalUsd.toFixed(2)} exceeds max $${config.maxNotionalUsd}`;
    logger.warn(`[SAFETY] BLOCKED: ${reason}`);
    return { allowed: false, reason };
  }
  return { allowed: true };
}

export function checkDuplicate(targetSize: number, currentSize: number): SafetyCheckResult {
  if (Math.abs(targetSize - currentSize) < 1e-8) {
    const reason = `Target size ${targetSize.toFixed(4)} identical to current ${currentSize.toFixed(4)}`;
    logger.info(`[SAFETY] BLOCKED: ${reason}`);
    return { allowed: false, reason };
  }
  return { allowed: true };
}

export function checkDailyLimit(count: number): SafetyCheckResult {
  if (count >= config.maxDailyRebalances) {
    const reason = `Daily rebalance limit reached: ${count}/${config.maxDailyRebalances}`;
    logger.warn(`[SAFETY] BLOCKED: ${reason}`);
    return { allowed: false, reason };
  }
  return { allowed: true };
}

export function checkHourlyLimit(count: number): SafetyCheckResult {
  if (count >= config.maxHourlyRebalances) {
    const reason = `Hourly rebalance limit reached: ${count}/${config.maxHourlyRebalances}`;
    logger.warn(`[SAFETY] BLOCKED: ${reason}`);
    return { allowed: false, reason };
  }
  return { allowed: true };
}

export function checkCooldown(lastTimestamp: number, cooldownSec: number = config.rebalanceIntervalMin * 60): SafetyCheckResult {
  const elapsed = (Date.now() - lastTimestamp) / 1000;
  if (elapsed < cooldownSec) {
    const remaining = cooldownSec - elapsed;
    const reason = `Cooldown active: ${remaining.toFixed(0)}s remaining`;
    logger.info(`[SAFETY] BLOCKED: ${reason}`);
    return { allowed: false, reason };
  }
  return { allowed: true };
}

export function runAllSafetyChecks(params: {
  changeUsd: number;
  totalNotionalUsd: number;
  targetSize: number;
  currentSize: number;
  dailyCount: number;
  hourlyCount: number;
  lastRebalanceTimestamp: number;
  cooldownSeconds?: number;
}): SafetyCheckResult {
  const checks = [
    checkMinNotional(params.changeUsd),
    checkMaxNotional(params.totalNotionalUsd),
    checkDuplicate(params.targetSize, params.currentSize),
    checkDailyLimit(params.dailyCount),
    checkHourlyLimit(params.hourlyCount),
    checkCooldown(params.lastRebalanceTimestamp, params.cooldownSeconds ?? config.rebalanceIntervalMin * 60),
  ];

  for (const check of checks) {
    if (!check.allowed) return check;
  }

  return { allowed: true };
}

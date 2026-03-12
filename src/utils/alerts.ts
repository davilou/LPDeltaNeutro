import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { LogContext, getLogContext } from './correlation';

let bot: TelegramBot | null = null;
let botInitWarned = false;

function getBot(): TelegramBot | null {
  if (bot) return bot;
  if (!config.telegramBotToken || !config.telegramChatId) {
    if (!botInitWarned) {
      // Use console.warn here to avoid circular import with logger
      console.warn('[Alerts] Telegram not configured — alerts disabled');
      botInitWarned = true;
    }
    return null;
  }
  bot = new TelegramBot(config.telegramBotToken, { polling: false });
  return bot;
}

// Rate limiting: max 1 alert per key per 60 seconds
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;
let suppressedCount = 0;

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const lastSent = rateLimitMap.get(key);
  if (lastSent && now - lastSent < RATE_LIMIT_MS) {
    suppressedCount++;
    return true;
  }
  rateLimitMap.set(key, now);
  return false;
}

// Cleanup old rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_MS;
  for (const [key, ts] of rateLimitMap) {
    if (ts < cutoff) rateLimitMap.delete(key);
  }
  if (suppressedCount > 0) {
    const b = getBot();
    if (b) {
      b.sendMessage(
        config.telegramChatId,
        `⚠️ ${suppressedCount} alerta(s) suprimido(s) nos últimos 5min`,
      ).catch(() => {});
    }
    suppressedCount = 0;
  }
}, 5 * 60_000).unref();

export async function sendAlert(
  level: 'warning' | 'critical',
  message: string,
  context?: Partial<LogContext>,
): Promise<void> {
  const b = getBot();
  if (!b) return;

  const ctx = { ...getLogContext(), ...context };
  const rateLimitKey = `${message}:${ctx.userId ?? ''}:${ctx.tokenId ?? ''}`;
  if (isRateLimited(rateLimitKey)) return;

  const icon = level === 'critical' ? '🔴' : '🟡';
  const posInfo = ctx.tokenId
    ? `Position: NFT #${ctx.tokenId}${ctx.chain ? ` (${ctx.chain}/${ctx.dex ?? '?'})` : ''}`
    : '';

  const text = [
    `${icon} ${level.toUpperCase()} — lpdeltaneutro`,
    '',
    message,
    ctx.userId ? `User: ${ctx.userId}` : '',
    posInfo,
    ctx.correlationId ? `Correlation: ${ctx.correlationId}` : '',
    '',
    new Date().toISOString(),
  ].filter(Boolean).join('\n');

  try {
    await b.sendMessage(config.telegramChatId, text);
  } catch {
    // Silently fail — don't crash the bot because of alert delivery issues
  }
}

export async function notifyCriticalError(
  correlationId: string,
  error: unknown,
  context?: Partial<LogContext>,
): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack
    ? error.stack.split('\n').slice(0, 4).join('\n')
    : '';

  const message = stack
    ? `${errMsg}\n\n${stack}`
    : errMsg;

  await sendAlert('critical', message, { ...context, correlationId });
}

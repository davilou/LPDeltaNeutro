export interface FeeSnapshot {
  ts: number;       // unix timestamp em segundos
  feesUsd: number;  // fees brutas acumuladas on-chain neste momento
}

export interface HourlyFeeBucket {
  ts: number;            // início da hora (unix timestamp, segundos)
  deltaFeesUsd: number;  // fees geradas durante essa hora
}

export interface FeeHistory {
  snapshots: FeeSnapshot[];    // últimas 24h, granularidade por ciclo
  buckets: HourlyFeeBucket[];  // janela 24h–7d, agregados por hora
}

export interface AprMetrics {
  aprAllTime: number | null;
  apr7d: number | null;
  apr24h: number | null;
  dailyFeesUsd: number | null;
}

const WINDOW_24H = 86400;
const WINDOW_7D  = 604800;

/**
 * Adiciona snapshot de fees e mantém o rolling window:
 * - Últimas 24h: granularidade por ciclo (~5 min)
 * - 24h–7d: agregados em buckets horários
 * - Descarta dados com mais de 7 dias
 *
 * Regra de agregação sem sobreposição: uma hora só é agregada em bucket
 * quando TODOS os seus snapshots saíram da janela de 24h (hora inteira expirou).
 */
export function pushSnapshot(history: FeeHistory, feesUsd: number, nowTs?: number): FeeHistory {
  const now = nowTs ?? Math.floor(Date.now() / 1000);
  const cutoff24h = now - WINDOW_24H;
  const cutoff7d  = now - WINDOW_7D;

  const newSnapshots: FeeSnapshot[] = [...history.snapshots, { ts: now, feesUsd }];

  const freshSnapshots = newSnapshots.filter(s => s.ts > cutoff24h);
  const expiredSnapshots = newSnapshots.filter(s => s.ts <= cutoff24h);

  // Agrupa expirados por hora
  const byHour = new Map<number, FeeSnapshot[]>();
  for (const s of expiredSnapshots) {
    const hourTs = Math.floor(s.ts / 3600) * 3600;
    if (!byHour.has(hourTs)) byHour.set(hourTs, []);
    byHour.get(hourTs)!.push(s);
  }

  // Agrega somente horas completamente fora da janela de 24h
  const newBuckets: HourlyFeeBucket[] = [...history.buckets];
  for (const [hourTs, snaps] of byHour.entries()) {
    const hourEnd = hourTs + 3600;
    if (hourEnd > cutoff24h) continue; // hora ainda tem snapshots dentro da janela — aguarda
    const sorted = snaps.slice().sort((a, b) => a.ts - b.ts);
    const delta = sorted[sorted.length - 1].feesUsd - sorted[0].feesUsd;
    const existingIdx = newBuckets.findIndex(b => b.ts === hourTs);
    if (existingIdx >= 0) {
      newBuckets[existingIdx] = { ts: hourTs, deltaFeesUsd: Math.max(0, delta) };
    } else {
      newBuckets.push({ ts: hourTs, deltaFeesUsd: Math.max(0, delta) });
    }
  }

  const prunedBuckets = newBuckets.filter(b => b.ts >= cutoff7d);

  return { snapshots: freshSnapshots, buckets: prunedBuckets };
}

/**
 * Calcula APR a partir do histórico de snapshots e buckets.
 * @param initialTimestamp - em milissegundos (como em PnlState)
 * @param currentFeesUsd - fees brutas on-chain atuais em USD
 */
export function computeApr(
  history: FeeHistory,
  initialLpUsd: number,
  initialTimestamp: number,
  currentFeesUsd: number,
): AprMetrics {
  const empty: AprMetrics = { aprAllTime: null, apr7d: null, apr24h: null, dailyFeesUsd: null };

  if (!initialLpUsd || initialLpUsd <= 0) return empty;

  const nowTs = Math.floor(Date.now() / 1000);
  const activationTs = Math.floor(initialTimestamp / 1000); // ms → s

  // APR All-time
  let aprAllTime: number | null = null;
  const daysSince = (nowTs - activationTs) / 86400;
  if (daysSince >= 1 && currentFeesUsd >= 0) {
    aprAllTime = (currentFeesUsd / initialLpUsd) * (365 / daysSince) * 100;
  }

  // APR 24h — usa snapshots[]
  let apr24h: number | null = null;
  if (history.snapshots.length >= 2) {
    const oldest = history.snapshots.reduce((a, b) => a.ts < b.ts ? a : b);
    const horasDecorridas = (nowTs - oldest.ts) / 3600;
    if (horasDecorridas >= 1) {
      const delta24h = Math.max(0, currentFeesUsd - oldest.feesUsd);
      apr24h = (delta24h / initialLpUsd) * (8760 / horasDecorridas) * 100;
    }
  }

  // APR 7d — combina buckets (>24h) + snapshots atuais (últimas 24h)
  let apr7d: number | null = null;
  const cutoff7d = nowTs - WINDOW_7D;
  const bucketsTotal = history.buckets
    .filter(b => b.ts >= cutoff7d)
    .reduce((sum, b) => sum + b.deltaFeesUsd, 0);
  const snapshotsDelta = history.snapshots.length >= 2
    ? Math.max(0, currentFeesUsd - history.snapshots.reduce((a, b) => a.ts < b.ts ? a : b).feesUsd)
    : 0;
  const delta7d = bucketsTotal + snapshotsDelta;

  const allTsPoints = [
    ...history.buckets.map(b => b.ts),
    ...history.snapshots.map(s => s.ts),
  ];
  if (allTsPoints.length > 0) {
    const oldestTs = Math.min(...allTsPoints);
    const horasDecorridas7d = (nowTs - oldestTs) / 3600;
    if (horasDecorridas7d >= 6) {
      apr7d = (delta7d / initialLpUsd) * (8760 / horasDecorridas7d) * 100;
    }
  }

  const dailyFeesUsd = aprAllTime !== null
    ? (aprAllTime / 100) * initialLpUsd / 365
    : null;

  return { aprAllTime, apr7d, apr24h, dailyFeesUsd };
}

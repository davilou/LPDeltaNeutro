import Transport from 'winston-transport';

const LOKI_PUSH_PATH = '/loki/api/v1/push';
const FLUSH_INTERVAL_MS = 10_000; // flush every 10s
const MAX_BATCH_SIZE = 50;        // max entries per push
const MAX_RETRIES = 2;

interface LokiTransportOptions extends Transport.TransportStreamOptions {
  host: string;
  labels: Record<string, string>;
  basicAuth?: string;
  tenantId?: string;
}

interface LokiEntry {
  ts: string;
  line: string;
}

export class LokiHttpTransport extends Transport {
  private readonly pushUrl: string;
  private readonly labels: Record<string, string>;
  private readonly headers: Record<string, string>;
  private queue: LokiEntry[] = [];
  private timer: ReturnType<typeof setInterval>;
  private flushing = false;

  constructor(opts: LokiTransportOptions) {
    super(opts);
    this.pushUrl = opts.host.replace(/\/+$/, '') + LOKI_PUSH_PATH;
    this.labels = opts.labels;

    this.headers = { 'Content-Type': 'application/json' };
    if (opts.basicAuth) {
      this.headers['Authorization'] = 'Basic ' + Buffer.from(opts.basicAuth).toString('base64');
    }
    if (opts.tenantId) {
      this.headers['X-Scope-OrgID'] = opts.tenantId;
    }

    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref(); // don't block process exit
  }

  log(info: Record<string, unknown>, callback: () => void): void {
    // Clone info without Symbol fields that winston adds internally
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(info)) {
      clean[key] = info[key];
    }

    this.queue.push({
      ts: (Date.now() * 1_000_000).toString(), // nanosecond precision
      line: JSON.stringify(clean),
    });

    // Auto-flush if batch is large
    if (this.queue.length >= MAX_BATCH_SIZE) {
      this.flush();
    }

    callback();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;

    const entries = this.queue.splice(0, MAX_BATCH_SIZE);
    const payload = {
      streams: [{
        stream: this.labels,
        values: entries.map(e => [e.ts, e.line]),
      }],
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(this.pushUrl, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(payload),
        });

        if (resp.ok || resp.status === 204) {
          break; // success
        }

        const body = await resp.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.error(`[Loki] Push failed (${resp.status}): ${body.slice(0, 200)}`);

        if (resp.status === 429) {
          // Rate limited — wait and retry
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }

        // Non-retryable error — drop entries
        break;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[Loki] Push error (attempt ${attempt + 1}):`, err);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    this.flushing = false;

    // If there are more entries queued, schedule another flush
    if (this.queue.length > 0) {
      setTimeout(() => this.flush(), 500);
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.flush();
  }
}

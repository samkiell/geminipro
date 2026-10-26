import type { Alert, Notify } from './notifier.js';

// Production errors reach the owner within seconds: every log line at error or fatal level becomes
// an alert (Telegram, email, ntfy). The same error is sent at most once per window, with a count
// of its repeats next time, and a burst is capped, so an outage sends a handful of alerts, not
// hundreds. Lines are already redacted by pino; secrets and links are scrubbed again here.

export interface ErrorAlertOptions {
  /** One alert per distinct error per window. Default 30 minutes. */
  windowMs?: number;
  /** Most alerts per window across all errors. Default 10. */
  maxPerWindow?: number;
  now?: () => number;
}

interface LogLine {
  level: number;
  msg?: string;
  /** Set on lines the notifier writes for alerts it is already sending. */
  alert?: unknown;
  /** A serialized Error, or whatever was thrown (an unhandled rejection can be any value). */
  err?: { type?: string; message?: string; stack?: string } | string;
  req?: { method?: string; url?: string };
  [key: string]: unknown;
}

const ERROR = 50;
const FATAL = 60;
// The notifier's own failure: alerting about it would go through the same broken channels.
const SKIP = new Set(['notifier failed']);
const CONTEXT = ['step', 'orderNo', 'orderId', 'eventId', 'referrerId', 'telegramId', 'channel'];
const MAX_EARLY = 5;

const SECRETS = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
  /\bsk_(live|sandbox)_[A-Za-z0-9_-]{8,}/g,
  /\brsp_live_[A-Za-z0-9_-]{8,}/g,
  /\bgsk_[A-Za-z0-9]{8,}/g,
  /\bnpg_[A-Za-z0-9]{6,}/g,
  /\bre_[A-Za-z0-9]{16,}/g,
  /postgres(ql)?:\/\/\S+/gi,
];

export function scrubSecrets(text: string): string {
  return SECRETS.reduce((t, pattern) => t.replace(pattern, '[redacted]'), text);
}

export function createErrorAlerts(options: ErrorAlertOptions = {}) {
  const windowMs = options.windowMs ?? 30 * 60_000;
  const maxPerWindow = options.maxPerWindow ?? 10;
  const now = options.now ?? Date.now;
  let notify: (Notify & { settled?: () => Promise<void> }) | undefined;
  const early: Alert[] = [];
  const seen = new Map<string, { at: number; repeats: number }>();
  let windowStart = 0;
  let sentInWindow = 0;

  function toAlert(line: LogLine, repeats: number): Alert {
    const msg = line.msg ?? 'error';
    const context = CONTEXT.filter((k) => line[k] !== undefined).map((k) => `${k}: ${String(line[k])}`);
    if (line.req?.method) context.push(`request: ${line.req.method} ${line.req.url ?? ''}`);
    const thrown = typeof line.err === 'string' ? { message: line.err } : line.err;
    const err = thrown?.message ? `${thrown.type ?? 'Error'}: ${thrown.message}`.slice(0, 400) : undefined;
    const frame = thrown?.stack
      ?.split('\n')
      .slice(1)
      .find((l) => /dist\/|src\//.test(l))
      ?.trim();
    const body = [
      msg,
      ...context,
      ...(err ? [err] : []),
      ...(frame ? [frame.slice(0, 200)] : []),
      ...(repeats > 0 ? [`(happened ${repeats} more ${repeats === 1 ? 'time' : 'times'} since the last alert)`] : []),
    ].join('\n');
    return {
      level: line.level >= FATAL ? 'critical' : 'warning',
      title: `${line.level >= FATAL ? 'crash' : 'error'}: ${msg}`.slice(0, 80),
      body: scrubSecrets(body),
    };
  }

  function handle(raw: string): void {
    let line: LogLine;
    try {
      line = JSON.parse(raw) as LogLine;
    } catch {
      return;
    }
    if (typeof line.level !== 'number' || line.level < ERROR || line.alert !== undefined || SKIP.has(line.msg ?? '')) return;

    const errText = typeof line.err === 'string' ? line.err : (line.err?.message ?? '');
    const key = `${line.msg ?? ''}|${errText}`.replace(/\d+/g, '#').slice(0, 300);
    const t = now();
    const previous = seen.get(key);
    if (previous && t - previous.at < windowMs) {
      previous.repeats++;
      return;
    }
    if (t - windowStart >= windowMs) {
      windowStart = t;
      sentInWindow = 0;
    }
    if (sentInWindow >= maxPerWindow) return;
    sentInWindow++;
    seen.set(key, { at: t, repeats: 0 });
    if (seen.size > 1_000) seen.clear();

    const alert = toAlert(line, previous?.repeats ?? 0);
    if (notify) notify(alert);
    else if (early.length < MAX_EARLY) early.push(alert);
  }

  return {
    /** A pino destination for lines at error level and above. */
    stream: { write: handle },
    /** Starts sending; errors logged before this (during boot) go out now. */
    attach(n: Notify & { settled?: () => Promise<void> }): void {
      notify = n;
      for (const alert of early.splice(0)) n(alert);
    },
    /** Waits up to `timeoutMs` for alerts in flight, e.g. before exiting on a crash. */
    async flush(timeoutMs = 3_000): Promise<void> {
      await Promise.race([notify?.settled?.(), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
    },
  };
}

export type ErrorAlerts = ReturnType<typeof createErrorAlerts>;

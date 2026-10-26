import type { TelegramPort } from '../bot/telegram.js';
import type { Db } from '../db/client.js';
import type { Logger } from '../util/logger.js';
import { getSetting, setSetting } from './settings.js';

// Owner alerts (docs/ARCHITECTURE.md 9): email (Resend), the admins' Telegram chats and ntfy.sh,
// all at once. Never throws, never blocks the caller, never carries a link.

export type AlertLevel = 'info' | 'warning' | 'critical';

export interface Alert {
  level: AlertLevel;
  title: string;
  body: string;
  /**
   * System-wide triggers (low balance, bad signatures, rate limits...) set this: one alert per key
   * per cooldown window, kept across restarts. Per order alerts leave it out and always go.
   */
  cooldownKey?: string;
}

/** Sends an alert to the owner. Never throws. */
export type Notify = (alert: Alert) => void;

/** Alerts to the log only (tests, and before the real channels exist). */
export function logNotifier(logger: Logger): Notify {
  return ({ level, title, body }) => {
    const method = level === 'critical' ? 'error' : level === 'warning' ? 'warn' : 'info';
    logger[method]({ alert: title }, body);
  };
}

export interface NotifierDeps {
  logger: Logger;
  db?: Db;
  port: TelegramPort;
  adminIds: number[];
  alertEmail: string;
  alertEmailFrom: string;
  resendApiKey: string | undefined;
  ntfyTopic: string;
  ntfyServer?: string;
  fetch?: typeof fetch;
  /** Default 30 minutes. */
  cooldownMs?: number;
  now?: () => number;
}

const EMOJI: Record<AlertLevel, string> = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
const NTFY_PRIORITY: Record<AlertLevel, string> = { info: '3', warning: '4', critical: '5' };
const TIMEOUT_MS = 8_000;

/** Alerts must never carry a link: activation links above all, but no link at all is simplest. */
export function scrubLinks(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, '[link removed]');
}

export function createNotifier(deps: NotifierDeps): Notify & { settled: () => Promise<void> } {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cooldownMs = deps.cooldownMs ?? 30 * 60_000;
  const now = deps.now ?? Date.now;
  const lastSent = new Map<string, number>();
  const checks = new Map<string, Promise<boolean>>();
  const pending = new Set<Promise<void>>();

  /** One check per key at a time, so a burst of the same trigger cannot all read "not sent yet". */
  function coolingDown(key: string): Promise<boolean> {
    const next = (checks.get(key) ?? Promise.resolve(false)).then(() => checkCooldown(key));
    checks.set(key, next.catch(() => false));
    return next;
  }

  async function checkCooldown(key: string): Promise<boolean> {
    const t = now();
    let last = lastSent.get(key);
    if (last === undefined && deps.db) {
      last = (await getSetting<number>(deps.db, `alert_cooldown:${key}`).catch(() => undefined)) ?? undefined;
    }
    if (last !== undefined && t - last < cooldownMs) return true;
    lastSent.set(key, t);
    if (deps.db) await setSetting(deps.db, `alert_cooldown:${key}`, t).catch(() => {});
    return false;
  }

  async function email(alert: Alert, text: string): Promise<void> {
    if (!deps.resendApiKey) {
      deps.logger.info({ alert: alert.title }, 'email alert skipped (no RESEND_API_KEY)');
      return;
    }
    const res = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: deps.alertEmailFrom,
        to: [deps.alertEmail],
        subject: `[geminipro] ${alert.title}`,
        text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`resend returned ${res.status}`);
  }

  async function telegram(alert: Alert, text: string): Promise<void> {
    await Promise.all(deps.adminIds.map((id) => deps.port.send(id, { text: `${EMOJI[alert.level]} ${alert.title}\n${text}` })));
  }

  async function ntfy(alert: Alert, text: string): Promise<void> {
    const res = await doFetch(`${deps.ntfyServer ?? 'https://ntfy.sh'}/${deps.ntfyTopic}`, {
      method: 'POST',
      headers: {
        Title: `geminipro: ${alert.title}`.replace(/[^\x20-\x7e]/g, ''),
        Priority: NTFY_PRIORITY[alert.level],
        Tags: alert.level === 'critical' ? 'rotating_light' : alert.level === 'warning' ? 'warning' : 'information_source',
      },
      body: text,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
  }

  async function deliver(alert: Alert): Promise<void> {
    if (alert.cooldownKey && (await coolingDown(alert.cooldownKey))) {
      deps.logger.debug({ alert: alert.title }, 'alert skipped: cooling down');
      return;
    }
    const text = scrubLinks(alert.body);
    deps.logger[alert.level === 'critical' ? 'error' : alert.level === 'warning' ? 'warn' : 'info']({ alert: alert.title }, text);
    const channels = { email, telegram, ntfy };
    const results = await Promise.allSettled(Object.values(channels).map((send) => send(alert, text)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        deps.logger.warn({ channel: Object.keys(channels)[i], err: (result.reason as Error).message }, 'alert channel failed');
      }
    });
  }

  const notify = (alert: Alert) => {
    const job = deliver(alert).catch((err: unknown) => deps.logger.error({ err }, 'notifier failed'));
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };
  /** Resolves when every alert sent so far has finished (tests, shutdown). */
  notify.settled = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  return notify;
}

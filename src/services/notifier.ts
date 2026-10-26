import type { Logger } from '../util/logger.js';

export type AlertLevel = 'info' | 'warning' | 'critical';

export interface Alert {
  level: AlertLevel;
  title: string;
  body: string;
}

/** Sends an alert to the owner. Never throws. */
export type Notify = (alert: Alert) => void;

/** Stand-in until email, Telegram and ntfy delivery exist: alerts only reach the log. */
export function logNotifier(logger: Logger): Notify {
  return ({ level, title, body }) => {
    const method = level === 'critical' ? 'error' : level === 'warning' ? 'warn' : 'info';
    logger[method]({ alert: title }, body);
  };
}

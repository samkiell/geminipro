import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createErrorAlerts, scrubSecrets } from '../src/services/error-alerts.js';
import type { Alert } from '../src/services/notifier.js';
import { createLogger } from '../src/util/logger.js';

/** A production style logger whose stdout is discarded, with alerts collected. */
function setup(options: Parameters<typeof createErrorAlerts>[0] = {}) {
  let t = 1_000_000;
  const alerts: Alert[] = [];
  const errorAlerts = createErrorAlerts({ now: () => t, ...options });
  const stdout = new Writable({ write: (_chunk, _enc, done) => done() });
  const logger = createLogger({ level: 'info', destination: stdout as never, errorStream: errorAlerts.stream });
  errorAlerts.attach((alert) => alerts.push(alert));
  return { logger, alerts, errorAlerts, advance: (ms: number) => (t += ms) };
}

describe('error alerts', () => {
  it('sends an error with its message, context and cause; a fatal one as a crash', () => {
    const { logger, alerts } = setup();
    logger.child({ orderNo: 'GP-1042' }).error({ err: new Error('connect ETIMEDOUT'), step: 'recover fulfilment' }, 'reconciler step failed');
    logger.fatal({ err: new TypeError('x is undefined') }, 'uncaught exception, restarting');

    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ level: 'warning', title: 'error: reconciler step failed' });
    expect(alerts[0]?.body).toContain('step: recover fulfilment');
    expect(alerts[0]?.body).toContain('orderNo: GP-1042');
    expect(alerts[0]?.body).toContain('Error: connect ETIMEDOUT');
    expect(alerts[1]).toMatchObject({ level: 'critical', title: 'crash: uncaught exception, restarting' });
    expect(alerts[1]?.body).toContain('TypeError: x is undefined');
  });

  it('ignores warnings, lines the notifier writes for its own alerts, and its own failure', () => {
    const { logger, alerts } = setup();
    logger.warn('link purchase refused, trying again');
    logger.info('order delivered');
    logger.error({ alert: 'paid order not fulfilled' }, 'Order GP-1 is paid but no link could be bought.');
    logger.error({ err: new Error('telegram down') }, 'notifier failed');
    expect(alerts).toEqual([]);
  });

  it('sends the same error once per window, then again with how often it repeated', () => {
    const { logger, alerts, advance } = setup({ windowMs: 60_000 });
    for (let i = 0; i < 5; i++) logger.error({ err: new Error(`timeout after ${i}ms`) }, 'health check failed: database unreachable');
    expect(alerts).toHaveLength(1);

    advance(61_000);
    logger.error({ err: new Error('timeout after 9ms') }, 'health check failed: database unreachable');
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.body).toContain('(happened 4 more times since the last alert)');
  });

  it('caps a burst of different errors', () => {
    const { logger, alerts } = setup({ maxPerWindow: 3 });
    for (let i = 0; i < 10; i++) logger.error(`failure kind ${String.fromCharCode(97 + i)}`);
    expect(alerts).toHaveLength(3);
  });

  it('keeps errors logged before the notifier exists and sends them on attach', () => {
    const errorAlerts = createErrorAlerts();
    const stdout = new Writable({ write: (_chunk, _enc, done) => done() });
    const logger = createLogger({ level: 'info', destination: stdout as never, errorStream: errorAlerts.stream });
    logger.error({ err: new Error('getaddrinfo ENOTFOUND') }, 'database not reachable at boot');

    const alerts: Alert[] = [];
    errorAlerts.attach((alert) => alerts.push(alert));
    expect(alerts.map((a) => a.title)).toEqual(['error: database not reachable at boot']);
  });

  it('never carries secrets: redacted fields stay redacted and token shapes are scrubbed', () => {
    const { logger, alerts } = setup();
    logger.error(
      { token: '123456789:AAEabcdefghijklmnopqrstuvwxyz0123456', err: new Error('bad key sk_live_abcdefghijklmnop for postgres://u:p@host/db') },
      'bachs call failed',
    );
    const body = alerts[0]?.body ?? '';
    expect(body).not.toContain('AAEabcdefghijklmnopqrstuvwxyz');
    expect(body).not.toContain('sk_live_abcdefghijklmnop');
    expect(body).not.toContain('u:p@host');
    expect(scrubSecrets('rsp_live_0123456789abcdef and gsk_0123456789abcdef')).toBe('[redacted] and [redacted]');
  });
});

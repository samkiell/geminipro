import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNotifier, scrubLinks } from '../src/services/notifier.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { fakePort, type FakePort } from './helpers/telegram.js';

const logger = createLogger({ level: 'silent' });
let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tg: FakePort;
let requests: { url: string; headers: Record<string, string>; body: string }[];
let failNtfy: boolean;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  tg = fakePort();
  requests = [];
  failNtfy = false;
});

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body ?? '') });
  if (failNtfy && String(url).includes('ntfy')) throw new Error('network down');
  return new Response('{}', { status: 200 });
}) as typeof fetch;

function notifier(overrides: { now?: () => number; resendApiKey?: string | undefined } = {}) {
  return createNotifier({
    logger,
    db: testDb.db,
    port: tg.port,
    adminIds: [1, 2],
    alertEmail: 'hello@samkiel.dev',
    alertEmailFrom: 'alerts <onboarding@resend.dev>',
    resendApiKey: 're_test',
    ntfyTopic: 'geminipro-test',
    fetch: fakeFetch,
    ...overrides,
  });
}

describe('notifier', () => {
  it('sends to email, every admin chat and ntfy at once', async () => {
    const notify = notifier();
    notify({ level: 'critical', title: 'paid order not fulfilled', body: 'Order GP-1042 failed.' });
    await notify.settled();

    const email = requests.find((r) => r.url === 'https://api.resend.com/emails');
    expect(JSON.parse(email?.body ?? '{}')).toMatchObject({
      to: ['hello@samkiel.dev'],
      subject: '[geminipro] paid order not fulfilled',
      text: 'Order GP-1042 failed.',
    });
    expect(email?.headers.Authorization).toBe('Bearer re_test');
    const push = requests.find((r) => r.url === 'https://ntfy.sh/geminipro-test');
    expect(push?.headers).toMatchObject({ Priority: '5', Title: 'geminipro: paid order not fulfilled' });
    expect(tg.sent.map((m) => [m.chatId, m.text])).toEqual([
      [1, '🚨 paid order not fulfilled\nOrder GP-1042 failed.'],
      [2, '🚨 paid order not fulfilled\nOrder GP-1042 failed.'],
    ]);
  });

  it('a trigger with a cooldown key alerts once per window, even across a restart', async () => {
    let t = 1_000_000;
    const first = notifier({ now: () => t });
    for (let i = 0; i < 3; i++) first({ level: 'warning', title: 'low reseller balance', body: 'x', cooldownKey: 'low_balance' });
    await first.settled();
    expect(tg.sent).toHaveLength(2); // one alert, two admins

    // a restarted process remembers the window through the database
    const restarted = notifier({ now: () => t });
    restarted({ level: 'warning', title: 'low reseller balance', body: 'x', cooldownKey: 'low_balance' });
    await restarted.settled();
    expect(tg.sent).toHaveLength(2);

    t += 31 * 60_000;
    restarted({ level: 'warning', title: 'low reseller balance', body: 'x', cooldownKey: 'low_balance' });
    await restarted.settled();
    expect(tg.sent).toHaveLength(4);
  });

  it('order failures have no cooldown', async () => {
    const notify = notifier();
    notify({ level: 'critical', title: 'paid order not fulfilled', body: 'GP-1' });
    notify({ level: 'critical', title: 'paid order not fulfilled', body: 'GP-2' });
    await notify.settled();
    expect(tg.sent).toHaveLength(4);
  });

  it('never throws when a channel fails, and still uses the others', async () => {
    failNtfy = true;
    const notify = notifier({ resendApiKey: undefined });
    expect(() => notify({ level: 'info', title: 'new lead', body: '@sam: a website' })).not.toThrow();
    await notify.settled();
    expect(tg.sent).toHaveLength(2);
    expect(requests.some((r) => r.url.includes('resend'))).toBe(false); // no key: logged instead
  });

  it('strips links from alerts', async () => {
    expect(scrubLinks('link https://one.google.com/x?y=1 failed')).toBe('link [link removed] failed');
    const notify = notifier();
    notify({ level: 'info', title: 'new lead', body: 'see https://example.com/abc' });
    await notify.settled();
    expect(tg.sent[0]?.text).not.toContain('https://');
    expect(requests.every((r) => !r.body.includes('https://example.com'))).toBe(true);
  });
});

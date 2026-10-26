import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buyerContext, detectLang, noteLanguage } from '../src/agent/buyer.js';
import { nudgeTemplate } from '../src/agent/agent.js';
import { sendPaymentNudges } from '../src/agent/nudge.js';
import { leads, orders, users } from '../src/db/schema.js';
import { OWNER, OWNER_BLURB, OWNER_LINKS, ownerButtons } from '../src/knowledge/owner.js';
import { latestLeads, MAX_LEADS_PER_DAY, saveLead } from '../src/services/leads.js';
import type { Alert } from '../src/services/notifier.js';
import { isQuietHour, sendActivationReminders } from '../src/services/reminders.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { insertOrder } from './helpers/orders.js';
import { facts, fakePort } from './helpers/telegram.js';

const logger = createLogger({ level: 'silent' });
let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
});

describe('language and buyer context', () => {
  it('detects pidgin, plain english, and no signal', () => {
    expect(detectLang('abeg how much be this thing')).toBe('pcm');
    expect(detectLang('how far')).toBe('pcm');
    expect(detectLang('i wan buy two')).toBe('pcm');
    expect(detectLang('can you tell me how this works')).toBe('en');
    expect(detectLang('ok')).toBeUndefined();
    // "dey" inside other words does not count
    expect(detectLang('they said the day was fine today')).toBe('en');
  });

  it('remembers the language and describes the buyer in one short line', async () => {
    await testDb.db.insert(users).values({ telegramId: 42, firstName: 'Tunde' });
    expect(await buyerContext(testDb.db, 42)).toBe('buyer: tunde, new, no orders yet. writes english.');

    await noteLanguage(testDb.db, 42, 'abeg i wan another one');
    const id = await insertOrder(testDb.db, { status: 'delivered' });
    await insertOrder(testDb.db, { status: 'cancelled', paid: false });
    const [order] = await testDb.db.select().from(orders).where(eq(orders.id, id));
    const context = await buyerContext(testDb.db, 42);
    expect(context).toMatch(new RegExp(`^buyer: tunde, returning, 1 paid order, last ${order?.orderNo} delivered \\d+ \\w+\\. writes pidgin\\.$`));
    expect(context.split(/\s+/).length).toBeLessThanOrEqual(25);
  });
});

describe('owner knowledge', () => {
  it('holds no private information', () => {
    const all = [OWNER_BLURB, ...Object.values(OWNER).flat()].join('\n').toLowerCase();
    for (const banned of ['matric', 'birth', 'church', 'family', 'laptop', 'phone', 'balance', 'margin', 'cost price', 'supplier name']) {
      expect(all).not.toContain(banned);
    }
    expect(all).toContain('not affiliated with google or jio');
  });

  it('attaches the right link buttons per topic', () => {
    expect(ownerButtons('identity')).toEqual(['portfolio', 'github', 'linkedin']);
    expect(ownerButtons('projects')).toEqual(['portfolio', 'github', 'blog']);
    expect(ownerButtons('shop')).toEqual([]);
    expect(Object.values(OWNER_LINKS).every((u) => u.startsWith('https://'))).toBe(true);
  });
});

describe('leads', () => {
  it('saves a lead, alerts the owner, and allows 3 a day per user', async () => {
    const alerts: Alert[] = [];
    const notify = (a: Alert) => void alerts.push(a);
    for (let i = 0; i < MAX_LEADS_PER_DAY; i++) {
      expect(await saveLead(testDb.db, notify, { telegramId: 42, username: 'sam', summary: `website ${i}` })).toBe('saved');
    }
    expect(await saveLead(testDb.db, notify, { telegramId: 42, username: 'sam', summary: 'one more' })).toBe('limited');
    expect(await testDb.db.select().from(leads)).toHaveLength(3);
    expect(alerts[0]).toEqual({ level: 'info', title: 'new lead', body: '@sam: website 0' });
    expect((await latestLeads(testDb.db))[0]?.summary).toBe('website 2');
  });
});

describe('reminders and nudges', () => {
  it('quiet hours are 23:00 to 07:00 WAT', () => {
    expect(isQuietHour(new Date('2026-10-26T22:30:00Z'))).toBe(true); // 23:30 WAT
    expect(isQuietHour(new Date('2026-10-26T05:59:00Z'))).toBe(true); // 06:59 WAT
    expect(isQuietHour(new Date('2026-10-26T06:00:00Z'))).toBe(false); // 07:00 WAT
    expect(isQuietHour(new Date('2026-10-26T13:00:00Z'))).toBe(false);
  });

  it('sends one activation reminder per delivered order after the delay, never in quiet hours', async () => {
    const tg = fakePort();
    const id = await insertOrder(testDb.db, { status: 'delivered' });
    await testDb.db.update(orders).set({ deliveredAt: new Date(Date.now() - 4 * 3_600_000) }).where(eq(orders.id, id));
    await insertOrder(testDb.db, { status: 'delivered', telegramId: 7 }); // delivered just now

    const night = new Date('2026-10-26T23:30:00Z');
    expect(await sendActivationReminders({ db: testDb.db, port: tg.port, logger, delayMinutes: 180, now: night })).toBe(0);
    const day = new Date('2026-10-26T13:00:00Z');
    expect(await sendActivationReminders({ db: testDb.db, port: tg.port, logger, delayMinutes: 180, now: day })).toBe(1);
    expect(await sendActivationReminders({ db: testDb.db, port: tg.port, logger, delayMinutes: 180, now: day })).toBe(0);
    expect(tg.sent[0]?.text).toMatch(/^did you activate your link\? order GP-\d+\nif yes, tap below and i'll close it here\.$/);
    expect(tg.buttons(tg.sent[0]?.id).map((b) => b.text)).toEqual(['yes, activated ✅', 'i need help']);
  });

  it('nudges each abandoned payment once, about 10 minutes in, with a pay button', async () => {
    const tg = fakePort();
    const id = await insertOrder(testDb.db, { status: 'awaiting_payment', expiresAt: new Date(Date.now() + 4 * 60_000) });
    await testDb.db
      .update(orders)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000), checkoutUrl: 'https://pay.test/x' })
      .where(eq(orders.id, id));
    const deps = { db: testDb.db, port: tg.port, facts, logger, write: async (o: Parameters<typeof nudgeTemplate>[0]) => nudgeTemplate(o) };
    expect(await sendPaymentNudges(deps)).toBe(1);
    expect(await sendPaymentNudges(deps)).toBe(0);
    expect(tg.sent[0]?.text).toContain('still open');
    expect(tg.buttons(tg.sent[0]?.id)).toEqual([{ text: 'pay ₦3,500 + fee', url: 'https://pay.test/x' }]);
  });
});

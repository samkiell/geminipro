import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nudgeTemplate } from '../src/agent/agent.js';
import { sendPaymentNudges } from '../src/agent/nudge.js';
import { createBuyerServices, MAX_RESENDS_PER_ORDER } from '../src/agent/services.js';
import { createTools, type PayButton } from '../src/agent/tools.js';
import { events, messages, orderItems, orders } from '../src/db/schema.js';
import type { Alert } from '../src/services/notifier.js';
import { setPaused } from '../src/services/settings.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { insertOrder } from './helpers/orders.js';

const logger = createLogger({ level: 'silent' });
const LINK = 'https://one.google.com/activate/SECRET-LINK-1';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let sent: { chatId: number; text: string }[];
let alerts: Alert[];

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  sent = [];
  alerts = [];
});

function services() {
  return createBuyerServices({
    db: testDb.db,
    reseller: { getAvailability: async () => ({ canSell: true, maxQuantity: 10 }) },
    bachs: {
      createCheckout: async (input) => ({
        checkoutId: `chk_${input.orderId.slice(0, 8)}`,
        checkoutUrl: `https://sandbox-checkout.bachs.io/c/${input.orderId.slice(0, 8)}`,
        expiresAt: undefined,
      }),
    },
    pricing: { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 },
    maxQtyPerOrder: 10,
    salesCutoff: undefined,
    returnUrl: 'https://t.me/geminiprosamkiel_bot',
    supportWhatsapp: '08087357158',
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    notify: (alert) => alerts.push(alert),
    logger,
  });
}

async function deliveredOrder(telegramId = 42) {
  const id = await insertOrder(testDb.db, { status: 'delivered', telegramId });
  await testDb.db.insert(orderItems).values({
    orderId: id,
    idx: 0,
    idempotencyKey: `${id}-0`,
    status: 'completed',
    activationLink: LINK,
    deliveredAt: new Date(),
  });
  return id;
}

describe('buyer services behind the tools', () => {
  it('no tool result ever contains an activation link', async () => {
    const id = await deliveredOrder();
    const tools = createTools(services(), { maxQtyPerOrder: 10 });
    const results = await Promise.all([
      tools.execute('get_my_orders', '{}', { telegramId: 42 }),
      tools.execute('resend_my_links', JSON.stringify({ orderRef: id.slice(0, 8) }), { telegramId: 42 }),
      tools.execute('get_price', '{"quantity":2}', { telegramId: 42 }),
      tools.execute('check_availability', '{}', { telegramId: 42 }),
      tools.execute('escalate_to_support', '{"reason":"dead link"}', { telegramId: 42 }),
    ]);
    expect(JSON.stringify(results)).not.toContain(LINK);
    expect(results[0]).toMatchObject({
      orders: [{ orderRef: id.slice(0, 8), status: 'delivered', meaning: 'delivered', quantity: 1 }],
    });
    expect(results[1]).toEqual({ sent: 1 });
    // customer_pays: Bachs adds its fee at checkout, and the agent is told so.
    expect(results[2]).toEqual({
      quantity: 2,
      baseNgn: 7000,
      feeNgn: 0,
      totalNgn: 7000,
      feeNote: 'a small payment fee is added on the checkout page, on top of this total',
    });
    // The link went straight to the chat, from code.
    expect(sent).toEqual([{ chatId: 42, text: expect.stringContaining(LINK) }]);
  });

  it('resends only the caller’s own delivered links, at most 3 times', async () => {
    const id = await deliveredOrder(42);
    const s = services();
    expect(await s.resendMyLinks(7, id)).toEqual({ error: 'order_not_found' });
    expect(await s.resendMyLinks(42, 'not-a-uuid')).toEqual({ error: 'order_not_found' });
    for (let i = 0; i < MAX_RESENDS_PER_ORDER; i++) expect(await s.resendMyLinks(42, id)).toEqual({ sent: 1 });
    expect(await s.resendMyLinks(42, id)).toEqual({ error: 'resend_limit_reached' });
    expect(sent).toHaveLength(3);

    const unpaid = await insertOrder(testDb.db, { status: 'awaiting_payment', telegramId: 42 });
    expect(await s.resendMyLinks(42, unpaid)).toEqual({ error: 'no_delivered_links', status: 'awaiting_payment' });
  });

  it('finds the order by its short ref, or the latest delivered one when no ref is given', async () => {
    const older = await deliveredOrder(42);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await deliveredOrder(42);
    await insertOrder(testDb.db, { status: 'awaiting_payment', telegramId: 42 });
    const s = services();

    expect(await s.resendMyLinks(42, older.slice(0, 8).toUpperCase())).toEqual({ sent: 1 });
    expect(await s.resendMyLinks(42)).toEqual({ sent: 1 });
    expect(await s.resendMyLinks(99)).toEqual({ error: 'no_delivered_links' });

    const resent = await testDb.db.select({ ref: events.ref }).from(events).where(eq(events.kind, 'link_resend'));
    expect(resent.map((r) => r.ref)).toEqual([older, newer]);
  });

  it('create_payment_link reports an existing unpaid order with its pay link and time left', async () => {
    const s = services();
    const first = await s.createPaymentLink(42, 2);
    expect(first).toMatchObject({ ok: true, quantity: 2, totalNgn: 7000, expiresInMinutes: 15 });
    const again = await s.createPaymentLink(42, 1);
    expect(again).toMatchObject({
      ok: false,
      error: 'pending_order_exists',
      quantity: 2,
      totalNgn: 7000,
      checkoutUrl: first.ok ? first.checkoutUrl : '',
    });
    expect(!again.ok && again.error === 'pending_order_exists' && again.expiresInMinutes).toBeGreaterThan(13);
  });

  it('check_availability says no while paused', async () => {
    await setPaused(testDb.db, true);
    expect(await services().checkAvailability()).toMatchObject({ canSell: false, maxQuantity: 0 });
  });

  it('escalation alerts the owner and returns the support number', async () => {
    expect(await services().escalate(42, 'my link says expired')).toEqual({ supportWhatsapp: '08087357158' });
    expect(alerts).toEqual([{ level: 'warning', title: 'buyer needs support', body: 'Telegram user 42: my link says expired' }]);
  });
});

describe('sendPaymentNudges', () => {
  async function unpaidOrder({ ageMinutes, minutesLeft }: { ageMinutes: number; minutesLeft: number }, telegramId: number) {
    const id = await insertOrder(testDb.db, {
      status: 'awaiting_payment',
      telegramId,
      expiresAt: new Date(Date.now() + minutesLeft * 60_000),
    });
    await testDb.db
      .update(orders)
      .set({
        createdAt: sql`now() - make_interval(mins => ${ageMinutes})`,
        checkoutUrl: `https://sandbox-checkout.bachs.io/c/${id.slice(0, 8)}`,
      })
      .where(eq(orders.id, id));
    return id;
  }

  it('nudges each abandoned payment once, about 10 minutes in, with its pay button', async () => {
    const due = await unpaidOrder({ ageMinutes: 11, minutesLeft: 4 }, 1);
    await unpaidOrder({ ageMinutes: 5, minutesLeft: 10 }, 2);
    await unpaidOrder({ ageMinutes: 14, minutesLeft: 0.5 }, 3);

    const nudged: { chatId: number; text: string; button: PayButton }[] = [];
    const deps = {
      db: testDb.db,
      send: async (chatId: number, text: string, button: PayButton) => {
        nudged.push({ chatId, text, button });
      },
      write: async (o: { quantity: number; totalNgn: number; minutesLeft: number }) => nudgeTemplate(o),
      logger,
    };

    expect(await sendPaymentNudges(deps)).toBe(1);
    expect(await sendPaymentNudges(deps)).toBe(0);
    expect(nudged).toHaveLength(1);
    expect(nudged[0]).toMatchObject({ chatId: 1, button: { orderId: due, quantity: 1, totalNgn: 3500 } });
    expect(nudged[0]?.text).toContain('still open');

    const saved = await testDb.db.select().from(messages).where(eq(messages.telegramId, 1));
    expect(saved.map((m) => m.role)).toEqual(['assistant']);
  });
});

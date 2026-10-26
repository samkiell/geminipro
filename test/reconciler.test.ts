import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFlows } from '../src/bot/flows.js';
import { orderItems, orders } from '../src/db/schema.js';
import type { CheckoutSession } from '../src/services/bachs.js';
import { createFulfilment, itemIdempotencyKey } from '../src/services/fulfilment.js';
import { createNotifier, type Alert } from '../src/services/notifier.js';
import { createReconciler, type ReconcilerDeps } from '../src/services/reconciler.js';
import { computeAvailability, ResellerClient } from '../src/services/reseller.js';
import { getSetting } from '../src/services/settings.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getItems, getOrder, insertOrder } from './helpers/orders.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';
import { startMockReseller, type MockReseller } from './mocks/reseller-server.js';

const logger = createLogger({ level: 'silent' });
let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tg: FakePort;
let mock: MockReseller;
let alerts: Alert[];

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  tg = fakePort();
  alerts = [];
  mock = await startMockReseller({ apiKey: 'k', balanceCents: 10_000, priceCents: 120, stock: 100 });
});
afterEach(async () => {
  await mock.close();
});

function setup(overrides: Partial<ReconcilerDeps> = {}, checkout?: (id: string) => CheckoutSession) {
  const reseller = new ResellerClient({ baseUrl: mock.url, apiKey: 'k', productId: 1, maxQtyPerOrder: 10, timeoutMs: 2_000, backoffMs: 1, cacheTtlMs: 0 });
  const flows = createFlows({
    db: testDb.db,
    port: tg.port,
    logger,
    reseller: {
      getAvailability: async (r) =>
        computeAvailability({ balanceCents: 100_000, priceCents: 120, stock: 50, inStock: true, reservedUnits: r, maxQtyPerOrder: 10 }),
    },
    payments: { createCheckout: async () => ({ checkoutId: 'x', checkoutUrl: 'https://pay.test', expiresAt: undefined }) },
    pricing: { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 },
    facts,
    salesCutoff: undefined,
    returnUrl: undefined,
    notify: (a) => alerts.push(a),
    statusThrottleMs: 0,
  });
  const fulfilment = createFulfilment({
    db: testDb.db,
    reseller,
    productId: 1,
    port: tg.port,
    facts,
    notify: (a) => alerts.push(a),
    logger,
    onChange: flows.orderChanged,
    itemRetryDelaysMs: [1, 1],
  });
  const reconciler = createReconciler({
    db: testDb.db,
    logger,
    notify: (a) => alerts.push(a),
    flows,
    fulfil: (id) => fulfilment.fulfil(id),
    payments: {
      verifyPayment: async (id) => {
        if (!checkout) throw new Error('no checkout scripted');
        return checkout(id);
      },
    },
    reseller,
    productId: 1,
    lowBalanceLinks: 5,
    sendNudges: async () => 0,
    sendReminders: async () => 0,
    now: () => new Date('2026-10-26T13:00:00Z'), // 14:00 WAT, before the daily summary
    ...overrides,
  });
  return { reconciler, flows };
}

describe('reconciler', () => {
  it('acceptance: a fulfilment killed mid way completes once after a restart', async () => {
    // The process bought link 1 of 2 at the reseller, then died holding the lease.
    const id = await insertOrder(testDb.db, { status: 'fulfilling', quantity: 2, paid: true, leaseUntil: new Date(Date.now() - 60_000) });
    await testDb.db.insert(orderItems).values([
      { orderId: id, idx: 0, idempotencyKey: itemIdempotencyKey(id, 0) },
      { orderId: id, idx: 1, idempotencyKey: itemIdempotencyKey(id, 1) },
    ]);
    await new ResellerClient({ baseUrl: mock.url, apiKey: 'k', productId: 1, maxQtyPerOrder: 10 }).createOrder(1, itemIdempotencyKey(id, 0));

    // "restart": a fresh reconciler runs at boot, then again on its timer
    const { reconciler, flows } = setup();
    await reconciler.runOrders();
    await reconciler.runOrders();
    await flows.whenIdle();

    expect((await getOrder(testDb.db, id)).status).toBe('delivered');
    expect(mock.state.orders).toHaveLength(2); // nothing bought twice
    expect(tg.sent.filter((m) => m.text.startsWith('payment confirmed ✅'))).toHaveLength(1);
  });

  it('recovers paid orders that never started, and leaves held payments alone', async () => {
    const paid = await insertOrder(testDb.db, { status: 'paid', telegramId: 1 });
    const held = await insertOrder(testDb.db, { status: 'needs_attention', paid: false, telegramId: 2 });
    const { reconciler } = setup();
    await reconciler.runOrders();
    expect((await getOrder(testDb.db, paid)).status).toBe('delivered');
    expect((await getOrder(testDb.db, held)).status).toBe('needs_attention');
    expect(mock.state.orders).toHaveLength(1);
  });

  it('retries paid needs_attention orders only after a while, and never blocked deliveries', async () => {
    const stuck = await insertOrder(testDb.db, { status: 'needs_attention', paid: true, telegramId: 1 });
    const blocked = await insertOrder(testDb.db, { status: 'needs_attention', paid: true, telegramId: 2 });
    await testDb.db.update(orders).set({ error: 'delivery blocked: telegram 403' }).where(eq(orders.id, blocked));
    const { reconciler } = setup();
    await reconciler.runOrders();
    expect((await getOrder(testDb.db, stuck)).status).toBe('needs_attention'); // too recent

    await testDb.db.execute(sql`update orders set updated_at = now() - interval '11 minutes'`);
    await reconciler.runOrders();
    expect((await getOrder(testDb.db, stuck)).status).toBe('delivered');
    expect((await getOrder(testDb.db, blocked)).status).toBe('needs_attention');
  });

  it('expires unpaid orders and retires their cards', async () => {
    const { reconciler, flows } = setup();
    await flows.startBuy(42, 1);
    const [order] = await testDb.db.select().from(orders).where(eq(orders.telegramId, 42));
    await testDb.db.update(orders).set({ expiresAt: new Date(0) }).where(eq(orders.id, order?.id ?? ''));
    await reconciler.runOrders();
    await flows.whenIdle();
    expect((await getOrder(testDb.db, order?.id ?? '')).status).toBe('expired');
    expect(tg.get(order?.summaryMessageId)?.keyboard).toBeUndefined();
  });

  it('catches a payment whose webhook never arrived', async () => {
    const id = await insertOrder(testDb.db, { status: 'expired', paid: false });
    await testDb.db.update(orders).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(orders.id, id));
    const order = await getOrder(testDb.db, id);
    const { reconciler, flows } = setup({}, () => ({
      checkoutId: order.checkoutId ?? '',
      status: 'completed',
      paymentStatus: 'succeeded',
      amountMinor: 350_000,
      currency: 'NGN',
      reference: order.paymentReference,
    }));
    await reconciler.runOrders();
    await flows.whenIdle();
    expect((await getOrder(testDb.db, id)).status).toBe('delivered');
    expect((await getItems(testDb.db, id))[0]?.deliveredAt).toBeInstanceOf(Date);
  });

  it('acceptance: low balance alerts exactly once per cooldown window', async () => {
    mock.set({ balanceCents: 360 }); // covers 3 links, threshold 5
    let t = 1_000_000;
    const notify = createNotifier({
      logger,
      db: testDb.db,
      port: tg.port,
      adminIds: [1],
      alertEmail: 'a@b.c',
      alertEmailFrom: 'x',
      resendApiKey: undefined,
      ntfyTopic: 't',
      fetch: (async () => new Response('{}')) as typeof fetch,
      now: () => t,
    });
    const { reconciler } = setup({ notify });
    for (let i = 0; i < 4; i++) await reconciler.runBalance();
    await notify.settled();
    const lowBalance = () => tg.sent.filter((m) => m.text.startsWith('⚠️ low reseller balance'));
    expect(lowBalance()).toHaveLength(1);
    expect(lowBalance()[0]?.text).toContain('covers 3 more links');

    t += 31 * 60_000;
    await reconciler.runBalance();
    await notify.settled();
    expect(lowBalance()).toHaveLength(2);
  });

  it('alerts on low stock before balance when stock is the limit', async () => {
    mock.set({ stock: 2 });
    const { reconciler } = setup();
    await reconciler.runBalance();
    expect(alerts).toMatchObject([{ title: 'low stock', cooldownKey: 'low_stock' }]);
  });

  it('sends the daily summary once a day, at 21:00 WAT or later', async () => {
    await insertOrder(testDb.db, { status: 'delivered' });
    const before = setup({ now: () => new Date('2026-10-26T19:59:00Z') }); // 20:59 WAT
    await before.reconciler.runOrders();
    expect(alerts.filter((a) => a.title === 'daily summary')).toHaveLength(0);

    const after = setup({ now: () => new Date('2026-10-26T20:01:00Z') }); // 21:01 WAT
    await after.reconciler.runOrders();
    await after.reconciler.runOrders();
    const summaries = alerts.filter((a) => a.title === 'daily summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.body).toContain('today: 1 orders, 1 links sold, ₦3,500');
    expect(summaries[0]?.body).toContain('reseller: balance $');
    expect(await getSetting(testDb.db, 'last_daily_summary')).toBe('2026-10-26');
  });

  it('one failing job does not stop the others', async () => {
    const paid = await insertOrder(testDb.db, { status: 'paid' });
    const { reconciler } = setup({
      sendNudges: async () => {
        throw new Error('nudges broke');
      },
    });
    await reconciler.runOrders();
    expect((await getOrder(testDb.db, paid)).status).toBe('delivered');
  });
});

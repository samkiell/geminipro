import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFlows, type FlowDeps } from '../src/bot/flows.js';
import { orders } from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { verifyWebhookSignature, type CheckoutSession, type CreateCheckoutInput } from '../src/services/bachs.js';
import { createFulfilment } from '../src/services/fulfilment.js';
import type { Alert } from '../src/services/notifier.js';
import { expireUnpaidOrders, markPaid } from '../src/services/orders.js';
import { computeAvailability, ResellerClient } from '../src/services/reseller.js';
import { setOfferText } from '../src/services/settings.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getOrder, insertOrder } from './helpers/orders.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';
import { startMockReseller, type MockReseller } from './mocks/reseller-server.js';

const logger = createLogger({ level: 'silent' });
const BUYER = 42;
const SECRET = 'whsec_flow_test';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tg: FakePort;
let alerts: Alert[];
let checkouts: CreateCheckoutInput[];
let stock: number;

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
  checkouts = [];
  stock = 100;
});

function flows(overrides: Partial<FlowDeps> = {}) {
  return createFlows({
    db: testDb.db,
    port: tg.port,
    logger,
    reseller: {
      getAvailability: async (reserved) =>
        computeAvailability({ balanceCents: 100_000, priceCents: 120, stock, inStock: stock > 0, reservedUnits: reserved, maxQtyPerOrder: 10 }),
    },
    payments: {
      createCheckout: async (input) => {
        checkouts.push(input);
        return { checkoutId: `chk_${input.orderId.slice(0, 8)}`, checkoutUrl: `https://pay.test/${input.orderId}`, expiresAt: undefined };
      },
    },
    pricing: { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 },
    facts,
    salesCutoff: undefined,
    returnUrl: 'https://t.me/geminiprosamkiel_bot',
    notify: (alert) => alerts.push(alert),
    statusThrottleMs: 0,
    ...overrides,
  });
}

async function latestOrder() {
  const [order] = await testDb.db.select().from(orders).where(eq(orders.telegramId, BUYER)).orderBy(orders.createdAt);
  const all = await testDb.db.select().from(orders).where(eq(orders.telegramId, BUYER));
  return all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? order;
}

describe('buying', () => {
  it('/buy shows the summary card and a live status message, and stores their ids', async () => {
    const f = flows();
    const outcome = await f.startBuy(BUYER, 2);
    expect(outcome).toMatchObject({ ok: true, quantity: 2, totalNgn: 7000, maxQuantity: 10 });

    const order = await latestOrder();
    expect(order?.orderNo).toMatch(/^GP-\d{4,}$/);
    expect(order?.summaryMessageId).toBe(tg.sent[0]?.id);
    expect(order?.payMessageId).toBe(tg.sent[0]?.id);
    expect(order?.statusMessageId).toBe(tg.sent[1]?.id);
    expect(tg.sent[0]?.text).toContain(`order summary · ${order?.orderNo}`);
    expect(tg.buttons(order?.summaryMessageId).map((b) => b.text)).toEqual(['−', '2', '+', 'pay ₦7,000 + fee', 'cancel']);
    expect(tg.sent[1]?.text).toContain('⏳ waiting for payment');
    expect(checkouts).toHaveLength(1);
  });

  it('the stepper replaces the order but edits the same card and status message', async () => {
    const f = flows();
    await f.startBuy(BUYER, 1);
    const first = await latestOrder();
    const cardId = first?.summaryMessageId ?? 0;

    const outcome = await f.changeQuantity(BUYER, cardId, first?.id ?? '', 3);
    expect(outcome).toMatchObject({ ok: true, quantity: 3, totalNgn: 10_500 });

    const second = await latestOrder();
    expect(second?.id).not.toBe(first?.id);
    expect((await getOrder(testDb.db, first?.id ?? '')).status).toBe('cancelled');
    expect(second).toMatchObject({ summaryMessageId: cardId, statusMessageId: first?.statusMessageId, quantity: 3 });
    expect(tg.sent).toHaveLength(2); // nothing new: both messages were edited in place
    expect(tg.get(cardId)?.text).toContain(`order summary · ${second?.orderNo}`);
    expect(tg.get(cardId)?.text).toContain('quantity: 3 links');
    expect(tg.get(first?.statusMessageId)?.text).toContain(`order ${second?.orderNo}`);

    // the old order's buttons are stale now
    expect(await f.changeQuantity(BUYER, cardId, first?.id ?? '', 2)).toEqual({ ok: false, reason: 'stale' });
  });

  it('the stepper never goes past what is available', async () => {
    stock = 2;
    const f = flows();
    await f.startBuy(BUYER, 1);
    const first = await latestOrder();
    const outcome = await f.changeQuantity(BUYER, first?.summaryMessageId ?? 0, first?.id ?? '', 5);
    expect(outcome).toMatchObject({ ok: true, quantity: 2, maxQuantity: 2 });
    const plus = tg.buttons(first?.summaryMessageId).find((b) => b.text === '+');
    expect(plus && 'data' in plus && plus.data).toBe('n');
  });

  it('cancel collapses the card to one line with no buttons', async () => {
    const f = flows();
    await f.startBuy(BUYER, 1);
    const order = await latestOrder();
    expect(await f.cancelFromCard(BUYER, order?.id ?? '')).toBe(true);
    await f.whenIdle();
    expect(tg.get(order?.summaryMessageId)).toMatchObject({ text: `cancelled · order ${order?.orderNo}` });
    expect(tg.get(order?.summaryMessageId)?.keyboard).toBeUndefined();
    expect(tg.get(order?.statusMessageId)?.text).toContain('cancelled.');
    expect(await f.cancelFromCard(BUYER, order?.id ?? '')).toBe(false);
  });

  it('payment and expiry retire the card', async () => {
    const f = flows();
    await f.startBuy(BUYER, 1);
    const paidOrder = await latestOrder();
    await markPaid(testDb.db, paidOrder?.id ?? '');
    f.orderChanged(paidOrder?.id ?? '');
    await f.whenIdle();
    expect(tg.get(paidOrder?.summaryMessageId)).toMatchObject({ text: `paid ✅ order ${paidOrder?.orderNo}` });
    expect(tg.get(paidOrder?.summaryMessageId)?.keyboard).toBeUndefined();
    expect(tg.get(paidOrder?.statusMessageId)?.text).toContain('✅ payment received');

    await f.startBuy(BUYER, 1);
    const unpaid = await latestOrder();
    await testDb.db.update(orders).set({ expiresAt: new Date(0) }).where(eq(orders.id, unpaid?.id ?? ''));
    for (const o of await expireUnpaidOrders(testDb.db)) f.orderChanged(o.id);
    await f.whenIdle();
    expect(tg.get(unpaid?.summaryMessageId)?.text).toBe(`expired ⌛ order ${unpaid?.orderNo}. send /buy to start again.`);
    expect(tg.get(unpaid?.summaryMessageId)?.keyboard).toBeUndefined();
  });

  it('buying again with the same quantity moves the card down instead of making a new order', async () => {
    const f = flows();
    await f.startBuy(BUYER, 2);
    const first = await latestOrder();
    await f.startBuy(BUYER, 2);
    const again = await latestOrder();
    expect(again?.id).toBe(first?.id);
    expect(tg.get(first?.summaryMessageId)?.keyboard).toBeUndefined();
    expect(again?.summaryMessageId).not.toBe(first?.summaryMessageId);
    expect(tg.buttons(again?.summaryMessageId).map((b) => b.text)).toContain('pay ₦7,000 + fee');
    expect(checkouts).toHaveLength(1);
  });

  it('says how many it can sell when there is not enough', async () => {
    stock = 1;
    const f = flows();
    expect(await f.startBuy(BUYER, 3)).toEqual({ ok: false, reason: 'unavailable', maxQuantity: 1 });
    expect(tg.sent[0]).toMatchObject({ text: 'i can sell up to 1 right now.', keyboard: [[{ text: 'buy 1', data: 'b:1' }]] });
    stock = 0;
    const g = flows();
    expect(await g.startBuy(7, 1)).toEqual({ ok: false, reason: 'unavailable', maxQuantity: 0 });
    expect(tg.textsTo(7)).toEqual(["we're out of links right now. please check back soon."]);
  });

  it('the card shows the current offer text', async () => {
    await setOfferText(testDb.db, 'last 20 links left');
    await flows().startBuy(BUYER, 1);
    expect(tg.sent[0]?.text).toContain('🔥 last 20 links left');
  });
});

describe('history, order card and links', () => {
  it('pages through orders 5 at a time, editing one message', async () => {
    for (let i = 0; i < 7; i++) await insertOrder(testDb.db, { status: 'delivered', telegramId: BUYER });
    await insertOrder(testDb.db, { status: 'cancelled', telegramId: BUYER, paid: false });
    const f = flows();
    await f.showHistory(BUYER, 1);
    const listId = tg.sent[0]?.id ?? 0;
    const page1 = tg.buttons(listId);
    expect(page1.filter((b) => b.text.startsWith('GP-'))).toHaveLength(5);
    expect(page1.map((b) => b.text)).toContain('older ›');

    await f.showHistory(BUYER, 2, listId);
    expect(tg.sent).toHaveLength(1);
    const page2 = tg.buttons(listId);
    expect(page2.filter((b) => b.text.startsWith('GP-'))).toHaveLength(2); // the cancelled unpaid one is left out
    expect(page2.map((b) => b.text)).toContain('‹ newer');
  });

  it('only opens orders that belong to whoever tapped', async () => {
    const theirs = await insertOrder(testDb.db, { status: 'delivered', telegramId: 99 });
    const f = flows();
    expect(await f.showOrder(BUYER, theirs, 1)).toBe(false);
    expect(await f.showLinks(BUYER, theirs)).toBe('not_found');
    expect(await f.showOrderByNo(BUYER, (await getOrder(testDb.db, theirs)).orderNo)).toBe(false);
    expect(tg.sent).toHaveLength(0);
  });

  it('show my links is limited to 5 a minute per buyer', () => {
    const f = flows();
    for (let i = 0; i < 5; i++) expect(f.allowLinks(BUYER)).toBe(true);
    expect(f.allowLinks(BUYER)).toBe(false);
    expect(f.allowLinks(7)).toBe(true);
  });

  it('help navigates by editing one message', async () => {
    const f = flows();
    await f.showHelp(BUYER, 'hub');
    const id = tg.sent[0]?.id;
    await f.showHelp(BUYER, 'activate', id);
    await f.showHelp(BUYER, 'hub', id);
    expect(tg.sent).toHaveLength(1);
    expect(tg.edits.map((e) => e.text.split('\n')[0])).toEqual(['how to activate', 'how can i help? tap a topic below.']);
  });

  it('the activation reminder records a yes and brings in support on help', async () => {
    const id = await insertOrder(testDb.db, { status: 'delivered', telegramId: BUYER });
    const f = flows();
    const msg = await tg.port.send(BUYER, { text: 'did you activate your link?', keyboard: [[{ text: 'x', data: 'y' }]] });
    expect(await f.answerActivation(BUYER, msg, id, 'yes', 'sam')).toBe(true);
    expect((await getOrder(testDb.db, id)).activatedConfirmedAt).toBeInstanceOf(Date);
    expect(tg.get(msg)?.keyboard).toBeUndefined();

    const msg2 = await tg.port.send(BUYER, { text: 'did you activate your link?' });
    await f.answerActivation(BUYER, msg2, id, 'help', 'sam');
    expect(tg.buttons(msg2).map((b) => b.text)).toEqual(['need help on whatsapp']);
    expect(alerts.map((a) => a.title)).toEqual(['buyer needs help activating']);
  });
});

describe('acceptance: buy 3, pay, receive tap-to-copy links, find them in history', () => {
  let mock: MockReseller;
  afterEach(async () => {
    await mock?.close();
  });

  it('runs the whole flow', async () => {
    mock = await startMockReseller({ apiKey: 'k' });
    const f = flows();
    const fulfilment = createFulfilment({
      db: testDb.db,
      reseller: new ResellerClient({ baseUrl: mock.url, apiKey: 'k', productId: 1, maxQtyPerOrder: 10, timeoutMs: 2_000, backoffMs: 1 }),
      productId: 1,
      port: tg.port,
      facts,
      notify: (alert) => alerts.push(alert),
      logger,
      onChange: f.orderChanged,
      itemRetryDelaysMs: [1, 1],
    });
    const fulfilled: Promise<unknown>[] = [];
    let session: CheckoutSession | undefined = undefined;
    const app = buildServer({
      logger,
      pingDb: async () => {},
      bachsWebhook: {
        db: testDb.db,
        payments: {
          webhookConfigured: true,
          verifyWebhook: (raw, headers) => verifyWebhookSignature(raw, headers, SECRET),
          verifyPayment: async () => session as CheckoutSession,
        },
        notify: (alert) => alerts.push(alert),
        onPaid: (orderId) => {
          fulfilled.push(fulfilment.fulfil(orderId));
        },
        onChange: f.orderChanged,
      },
    });

    // /buy, then + + to 3
    await f.startBuy(BUYER, 1);
    let order = await latestOrder();
    const cardId = order?.summaryMessageId ?? 0;
    const statusId = order?.statusMessageId ?? 0;
    await f.changeQuantity(BUYER, cardId, order?.id ?? '', 2);
    order = await latestOrder();
    await f.changeQuantity(BUYER, cardId, order?.id ?? '', 3);
    order = await latestOrder();
    expect(order).toMatchObject({ quantity: 3, amountNgn: 10_500, status: 'awaiting_payment' });

    // the buyer pays; Bachs calls the webhook
    session = {
      checkoutId: order?.checkoutId ?? '',
      status: 'completed',
      paymentStatus: 'succeeded',
      amountMinor: 1_050_000,
      currency: 'NGN',
      reference: order?.paymentReference,
    };
    const body = JSON.stringify({ id: 'evt_accept', type: 'checkout.completed', data: { checkout_id: order?.checkoutId, reference: order?.paymentReference } });
    const t = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
    const res = await app.inject({
      method: 'POST',
      url: '/bachs/webhook',
      headers: { 'content-type': 'application/json', 'x-bachs-signature-v2': `t=${t},v1=${signature}` },
      payload: body,
    });
    expect(res.json()).toEqual({ ok: true, result: 'paid' });
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all(fulfilled);
    await f.whenIdle();
    await app.close();

    // three tap-to-copy links, in one message, buttons attached
    const delivery = tg.sent.find((m) => m.text.startsWith('payment confirmed ✅'));
    expect(delivery?.text.match(/<code>https:\/\/mock-reseller\.local\/activate\/[0-9a-f]+<\/code>/g)).toHaveLength(3);
    expect(delivery?.text).toContain('link 3 of 3');
    expect(tg.buttons(delivery?.id).map((b) => b.text)).toEqual(['need help on whatsapp', 'my orders']);

    // the card lost its buttons, the status message became the receipt
    expect(tg.get(cardId)).toMatchObject({ text: `paid ✅ order ${order?.orderNo}` });
    expect(tg.get(cardId)?.keyboard).toBeUndefined();
    expect(tg.get(statusId)?.text).toContain('✅ delivered');
    expect(tg.get(statusId)?.text).toContain('receipt: 3 links · ₦10,500 paid + fee');
    expect((await getOrder(testDb.db, order?.id ?? '')).status).toBe('delivered');

    // history shows it; opening it offers the links again
    await f.showHistory(BUYER, 1);
    const historyId = tg.sent.at(-1)?.id ?? 0;
    expect(tg.buttons(historyId).map((b) => b.text)).toEqual([expect.stringMatching(new RegExp(`^${order?.orderNo} · 3 links · .* · delivered ✅$`))]);
    await f.showOrder(BUYER, order?.id ?? '', 1, historyId);
    expect(tg.buttons(historyId).map((b) => b.text)).toContain('show my links');
    expect(await f.showLinks(BUYER, order?.id ?? '')).toBe('sent');
    expect(tg.sent.at(-1)?.text).toContain(`order ${order?.orderNo}\nyour links, tap to copy:`);
    expect(alerts).toEqual([]);
  });
});

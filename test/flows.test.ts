import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFlows, type FlowDeps } from '../src/bot/flows.js';
import { orderDrafts, orderItems, orders } from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { verifyWebhookSignature, type CheckoutSession, type CreateCheckoutInput } from '../src/services/bachs.js';
import { createFulfilment } from '../src/services/fulfilment.js';
import type { Alert } from '../src/services/notifier.js';
import { expireUnpaidOrders, markPaid } from '../src/services/orders.js';
import { computeAvailability, ResellerClient } from '../src/services/reseller.js';
import { setOfferText } from '../src/services/settings.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getItems, getOrder, insertOrder } from './helpers/orders.js';
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

describe('buying and draft cart', () => {
  it('/buy shows the draft card, creates an order_draft row, and creates no order row', async () => {
    const f = flows();
    const outcome = await f.startBuy(BUYER, 2);
    expect(outcome).toMatchObject({ ok: true, quantity: 2, totalNgn: 7000, maxQuantity: 10 });

    const order = await latestOrder();
    expect(order).toBeUndefined(); // No order row created!
    expect(checkouts).toHaveLength(0); // No checkout created!

    const draft = await testDb.db.select().from(orderDrafts).where(eq(orderDrafts.telegramId, BUYER));
    expect(draft).toHaveLength(1);
    expect(draft[0]?.quantity).toBe(2);
    expect(draft[0]?.messageId).toBe(tg.sent[0]?.id);

    expect(tg.sent).toHaveLength(1); // One response rule: only the draft card
    expect(tg.sent[0]?.text).toContain('how many links?');
    expect(tg.buttons(tg.sent[0]?.id).map((b) => b.text)).toEqual(['−', '2', '+', 'continue · ₦7,000 + fee', 'cancel']);
  });

  it('tapping + five times edits the same message and consumes zero order numbers until continue', async () => {
    const f = flows();
    await f.startBuy(BUYER, 1);
    const draftMsgId = tg.sent[0]?.id ?? 0;

    // Tap + five times (quantities 2, 3, 4, 5, 6)
    for (let q = 2; q <= 6; q++) {
      const outcome = await f.changeDraftQuantity(BUYER, draftMsgId, q);
      expect(outcome).toMatchObject({ ok: true, quantity: q, totalNgn: q * 3500 });
    }

    // Still no order rows!
    const ordersBefore = await testDb.db.select().from(orders).where(eq(orders.telegramId, BUYER));
    expect(ordersBefore).toHaveLength(0);
    expect(checkouts).toHaveLength(0);
    expect(tg.sent).toHaveLength(1); // edited in place
    expect(tg.get(draftMsgId)?.text).toContain('how many links?');
    expect(tg.buttons(draftMsgId).map((b) => b.text)).toEqual(['−', '6', '+', 'continue · ₦21,000 + fee', 'cancel']);

    // Now tap continue: exactly ONE order row and ONE checkout are created
    const continueResult = await f.continueDraft(BUYER, draftMsgId);
    expect(continueResult.ok).toBe(true);

    const ordersAfter = await testDb.db.select().from(orders).where(eq(orders.telegramId, BUYER));
    expect(ordersAfter).toHaveLength(1);
    expect(ordersAfter[0]?.orderNo).toMatch(/^GP-\d{4,}$/);
    expect(ordersAfter[0]?.quantity).toBe(6);
    expect(ordersAfter[0]?.amountNgn).toBe(21_000);
    expect(checkouts).toHaveLength(1);

    // Draft card was edited into payment card, draft row deleted
    expect(tg.sent).toHaveLength(1);
    expect(tg.get(draftMsgId)?.text).toContain(`order ${ordersAfter[0]?.orderNo} · 6 links`);
    expect(tg.buttons(draftMsgId).map((b) => b.text)).toEqual(['pay now', 'cancel']);
    const draftsAfter = await testDb.db.select().from(orderDrafts).where(eq(orderDrafts.telegramId, BUYER));
    expect(draftsAfter).toHaveLength(0);
  });

  it('abandoned drafts consume zero order numbers', async () => {
    const f = flows();
    await f.startBuy(BUYER, 3);
    const ordersList = await testDb.db.select().from(orders).where(eq(orders.telegramId, BUYER));
    expect(ordersList).toHaveLength(0);
  });

  it('cancel on draft card edits in place to cancelled', async () => {
    const f = flows();
    await f.startBuy(BUYER, 2);
    const draftMsgId = tg.sent[0]?.id ?? 0;
    await f.cancelDraft(BUYER, draftMsgId);

    expect(tg.get(draftMsgId)?.text).toBe('cancelled');
    expect(tg.buttons(draftMsgId)).toHaveLength(0);
    const drafts = await testDb.db.select().from(orderDrafts).where(eq(orderDrafts.telegramId, BUYER));
    expect(drafts).toHaveLength(0);
  });

  it('buying again when an active unpaid order exists shows that same payment card moved down', async () => {
    const f = flows();
    await f.startBuy(BUYER, 2);
    const draftMsgId = tg.sent[0]?.id ?? 0;
    await f.continueDraft(BUYER, draftMsgId);
    const firstOrder = await latestOrder();

    // Now buyer runs /buy again while first order is still unpaid
    await f.startBuy(BUYER, 1);
    const ordersAfter = await testDb.db.select().from(orders).where(eq(orders.telegramId, BUYER));
    expect(ordersAfter).toHaveLength(1); // Still exactly one order!
    expect(ordersAfter[0]?.id).toBe(firstOrder?.id);

    // Old payment card deleted (best effort) and moved down
    expect(tg.deleted).toContain(draftMsgId);
    const newCardId = ordersAfter[0]?.summaryMessageId;
    expect(newCardId).not.toBe(draftMsgId);
    expect(tg.get(newCardId)?.text).toContain(`order ${firstOrder?.orderNo}`);
  });

  it('the stepper never goes past what is available', async () => {
    stock = 2;
    const f = flows();
    await f.startBuy(BUYER, 1);
    const draftMsgId = tg.sent[0]?.id ?? 0;
    const outcome = await f.changeDraftQuantity(BUYER, draftMsgId, 5);
    expect(outcome).toMatchObject({ ok: true, quantity: 2, maxQuantity: 2 });
    const plus = tg.buttons(draftMsgId).find((b) => b.text === '+');
    expect(plus && 'data' in plus && plus.data).toBe('n');
  });

  it('payment and expiry retire the payment card', async () => {
    const f = flows();
    await f.startBuy(BUYER, 1);
    const msgId = tg.sent[0]?.id ?? 0;
    await f.continueDraft(BUYER, msgId);
    const paidOrder = await latestOrder();

    await markPaid(testDb.db, paidOrder?.id ?? '');
    f.orderChanged(paidOrder?.id ?? '');
    await f.whenIdle();
    expect(tg.get(msgId)?.text).toBe(`paid ✅ order ${paidOrder?.orderNo}`);
    expect(tg.get(msgId)?.keyboard).toBeUndefined();

    // Expiry test
    await f.startBuy(BUYER, 1);
    const unpaidMsgId = tg.sent.at(-1)?.id ?? 0;
    await f.continueDraft(BUYER, unpaidMsgId);
    const unpaid = await latestOrder();
    await testDb.db.update(orders).set({ expiresAt: new Date(0) }).where(eq(orders.id, unpaid?.id ?? ''));
    for (const o of await expireUnpaidOrders(testDb.db)) f.orderChanged(o.id);
    await f.whenIdle();
    expect(tg.get(unpaidMsgId)?.text).toBe('expired ⌛ send /buy to start again');
    expect(tg.get(unpaidMsgId)?.keyboard).toBeUndefined();
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

describe('channel gate', () => {
  const GATE = '@samkieldevtg';

  it('member passes through continue without interruption', async () => {
    tg.setChatMember(GATE, BUYER, 'member');
    const f = flows({ gateChannel: GATE, gateChannelUrl: 'https://t.me/samkieldevtg' });
    await f.startBuy(BUYER, 2);
    const msgId = tg.sent[0]?.id ?? 0;

    const result = await f.continueDraft(BUYER, msgId);
    expect(result.ok).toBe(true);
    expect(tg.get(msgId)?.text).toContain('order GP-');
    expect(tg.buttons(msgId).map((b) => b.text)).toEqual(['pay now', 'cancel']);
  });

  it('non-member is stopped at continue, alerted if clicking joined without joining, and passes when joined', async () => {
    tg.setChatMember(GATE, BUYER, 'left');
    const f = flows({ gateChannel: GATE, gateChannelUrl: 'https://t.me/samkieldevtg' });
    await f.startBuy(BUYER, 3);
    const msgId = tg.sent[0]?.id ?? 0;

    // Continue stops non-member with gate card
    const result = await f.continueDraft(BUYER, msgId);
    expect(result).toEqual({ ok: false, reason: 'gate_required' });
    expect(tg.get(msgId)?.text).toBe('join our channel to continue 👇');
    expect(tg.buttons(msgId).map((b) => b.text)).toEqual(['join channel', 'i have joined ✅']);

    // Tapping "i have joined ✅" before actually joining alerts user
    const recheck1 = await f.recheckGate(BUYER, msgId, 'query_1');
    expect(recheck1).toBe(false);
    expect(tg.answers.at(-1)).toEqual({ queryId: 'query_1', text: "you haven't joined yet", alert: true });

    // Now user joins the channel
    tg.setChatMember(GATE, BUYER, 'member');
    const recheck2 = await f.recheckGate(BUYER, msgId, 'query_2');
    expect(recheck2).toBe(true);
    // Draft card restored with preserved quantity (3)
    expect(tg.get(msgId)?.text).toContain('how many links?');
    expect(tg.buttons(msgId).map((b) => b.text)).toEqual(['−', '3', '+', 'continue · ₦10,500 + fee', 'cancel']);
  });

  it('leaving channel after joining is caught at next purchase', async () => {
    tg.setChatMember(GATE, BUYER, 'member');
    const f = flows({ gateChannel: GATE, gateChannelUrl: 'https://t.me/samkieldevtg' });
    await f.startBuy(BUYER, 1);
    const msg1 = tg.sent[0]?.id ?? 0;
    expect((await f.continueDraft(BUYER, msg1)).ok).toBe(true);

    // Cancel that order to buy again
    const ord = await latestOrder();
    await f.cancelFromCard(BUYER, ord?.id ?? '', msg1);

    // User leaves channel
    tg.setChatMember(GATE, BUYER, 'left');
    await f.startBuy(BUYER, 1);
    const msg2 = tg.sent.at(-1)?.id ?? 0;
    const res2 = await f.continueDraft(BUYER, msg2);
    expect(res2).toEqual({ ok: false, reason: 'gate_required' });
    expect(tg.get(msg2)?.text).toBe('join our channel to continue 👇');
  });

  it('getChatMember error fails open and alerts admin with 30m cooldown', async () => {
    // Port with failing getChatMember
    tg.port.getChatMember = async () => {
      throw new Error('Telegram API timeout');
    };
    const f = flows({ gateChannel: GATE, gateChannelUrl: 'https://t.me/samkieldevtg' });
    await f.startBuy(BUYER, 1);
    const msgId = tg.sent[0]?.id ?? 0;

    const result = await f.continueDraft(BUYER, msgId);
    expect(result.ok).toBe(true); // Fails open!
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toBe('channel gate check failed (failed open)');

    // Immediate second call should not alert again due to 30m cooldown
    await f.startBuy(999, 1);
    const msg2 = tg.sent.at(-1)?.id ?? 0;
    await f.continueDraft(999, msg2);
    expect(alerts).toHaveLength(1); // Still 1 alert!
  });

  it('admins bypass the channel gate even if not in channel', async () => {
    tg.setChatMember(GATE, BUYER, 'left');
    const f = flows({ gateChannel: GATE, adminUserIds: [BUYER] });
    await f.startBuy(BUYER, 1);
    const msgId = tg.sent[0]?.id ?? 0;

    const result = await f.continueDraft(BUYER, msgId);
    expect(result.ok).toBe(true);
    expect(tg.get(msgId)?.text).toContain('order GP-');
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

    // /buy, then + + to 3, then continue
    await f.startBuy(BUYER, 1);
    const cardId = tg.sent[0]?.id ?? 0;
    await f.changeDraftQuantity(BUYER, cardId, 2);
    await f.changeDraftQuantity(BUYER, cardId, 3);
    const continued = await f.continueDraft(BUYER, cardId);
    expect(continued.ok).toBe(true);
    const order = await latestOrder();
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
    const delivery = tg.sent.find((m) => m.text.startsWith('🎉 order'));
    expect(delivery?.text.match(/<code>https:\/\/mock-reseller\.local\/activate\/[0-9a-f]+<\/code>/g)).toHaveLength(3);
    expect(delivery?.text).toContain('link 3 of 3');
    expect(tg.buttons(delivery?.id).map((b) => b.text)).toEqual([
      '✅ link 1 activated',
      '✅ link 2 activated',
      '✅ link 3 activated',
      'need help',
      'invite & earn 🎁',
    ]);

    // the card lost its buttons, the status message became the receipt
    expect(tg.get(cardId)).toMatchObject({ text: `paid ✅ order ${order?.orderNo}` });
    expect(tg.get(cardId)?.keyboard).toBeUndefined();
    const deliveredOrder = await latestOrder();
    const statusId = deliveredOrder?.statusMessageId;
    if (statusId) {
      expect(tg.get(statusId)?.text).toContain('✅ delivered');
      expect(tg.get(statusId)?.text).toContain('receipt: 3 links · ₦10,500 paid + fee');
    }
    expect((await getOrder(testDb.db, order?.id ?? '')).status).toBe('delivered');

    // history shows it; opening it offers the links again
    await f.showHistory(BUYER, 1);
    const historyId = tg.sent.at(-1)?.id ?? 0;
    expect(tg.buttons(historyId).map((b) => b.text)).toEqual([expect.stringMatching(new RegExp(`^${order?.orderNo} · 3 links · .* · delivered ✅$`))]);
    await f.showOrder(BUYER, order?.id ?? '', 1, historyId);
    expect(tg.buttons(historyId).map((b) => b.text)).toContain('show my links');
    expect(await f.showLinks(BUYER, order?.id ?? '')).toBe('sent');
    const again = tg.sent.at(-1);
    expect(again?.text).toContain(`order ${order?.orderNo}\nyour links, tap to copy:`);

    // last step: the buyer marks link 1 activated, confirms, and it is closed wherever it was shown
    const [first] = await getItems(testDb.db, order?.id ?? '');
    const deliveryId = delivery?.id ?? 0;
    expect(await f.activationTap(BUYER, deliveryId, first?.id ?? '', 'ask')).toBe(true);
    expect(tg.buttons(deliveryId).map((b) => b.text)).toEqual(['yes, link 1 is activated. close it', 'not yet']);
    expect(await f.activationTap(BUYER, deliveryId, first?.id ?? '', 'yes')).toBe(true);
    for (const id of [deliveryId, again?.id]) {
      expect(tg.get(id)?.text).toContain('link 1 of 3: activated ✅');
      expect(tg.get(id)?.text).not.toContain(first?.activationLink ?? 'none');
    }
    expect(tg.buttons(deliveryId).map((b) => b.text)).toEqual(['✅ link 2 activated', '✅ link 3 activated', 'need help', 'invite & earn 🎁']);
    expect(alerts).toEqual([]);
  });
});

describe('activation', () => {
  async function deliveredOrder(quantity: number) {
    const id = await insertOrder(testDb.db, { status: 'delivered', telegramId: BUYER, quantity });
    await testDb.db.insert(orderItems).values(
      Array.from({ length: quantity }, (_, idx) => ({
        orderId: id,
        idx,
        idempotencyKey: `${id}-${idx}`,
        status: 'completed' as const,
        activationLink: `https://one.google.com/activate/${idx}`,
        deliveredAt: new Date(),
      })),
    );
    return { id, items: await getItems(testDb.db, id) };
  }

  it('activating every link closes them, marks the order activated and stops showing them', async () => {
    const { id, items } = await deliveredOrder(2);
    const f = flows();
    expect(await f.showLinks(BUYER, id)).toBe('sent');
    const msg = tg.sent.at(-1)?.id ?? 0;

    // "not yet" puts the buttons back and closes nothing
    await f.activationTap(BUYER, msg, items[0]?.id ?? '', 'ask');
    await f.activationTap(BUYER, msg, items[0]?.id ?? '', 'no');
    expect(tg.buttons(msg).map((b) => b.text)).toEqual(['\u2705 link 1 activated', '\u2705 link 2 activated', 'need help', 'invite & earn \ud83c\udf81']);
    expect((await getItems(testDb.db, id)).every((i) => i.activatedAt === null)).toBe(true);

    for (const item of items) await f.activationTap(BUYER, msg, item.id, 'yes');
    expect(tg.get(msg)?.text).toContain('these links are activated ✅');
    expect(tg.get(msg)?.text).not.toContain('https://');
    expect(tg.buttons(msg).map((b) => b.text)).toEqual(['need help', 'invite & earn \ud83c\udf81']);
    expect((await getOrder(testDb.db, id)).activatedConfirmedAt).toBeInstanceOf(Date);

    // closed for good: not in "show my links", not on the order card
    expect(await f.showLinks(BUYER, id)).toBe('closed');
    expect(tg.sent.at(-1)?.text).toContain("is activated, so they're closed");
    await f.showOrder(BUYER, id, 1);
    expect(tg.buttons(tg.sent.at(-1)?.id).map((b) => b.text)).not.toContain('show my links');
    expect(tg.sent.at(-1)?.text).toContain('activated: 2 links ✅ (closed)');
  });

  it('a tap twice closes once, and nobody else can close a buyer link', async () => {
    const { id, items } = await deliveredOrder(1);
    const f = flows();
    await f.showLinks(BUYER, id);
    const msg = tg.sent.at(-1)?.id ?? 0;
    expect(await f.activationTap(7, msg, items[0]?.id ?? '', 'yes')).toBe(false);
    expect(await f.activationTap(BUYER, msg, 'not-a-uuid', 'yes')).toBe(false);
    await f.activationTap(BUYER, msg, items[0]?.id ?? '', 'yes');
    const at = (await getItems(testDb.db, id))[0]?.activatedAt;
    await f.activationTap(BUYER, msg, items[0]?.id ?? '', 'yes');
    expect((await getItems(testDb.db, id))[0]?.activatedAt).toEqual(at);
    expect(tg.get(msg)?.text).toContain('activated ✅');
  });

  it('yes on the reminder closes every link of the order', async () => {
    const { id } = await deliveredOrder(1);
    const f = flows();
    await f.showLinks(BUYER, id);
    const linksMsg = tg.sent.at(-1)?.id ?? 0;
    const reminder = await tg.port.send(BUYER, { text: 'did you activate your link?' });
    await f.answerActivation(BUYER, reminder, id, 'yes', 'sam');
    expect(tg.get(linksMsg)?.text).not.toContain('https://');
    expect((await getItems(testDb.db, id))[0]?.activatedAt).toBeInstanceOf(Date);
  });
});

import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { orderItems, orders, users } from '../src/db/schema.js';
import { fulfil, itemIdempotencyKey, type FulfilmentDeps } from '../src/services/fulfilment.js';
import type { Alert } from '../src/services/notifier.js';
import { ResellerClient } from '../src/services/reseller.js';
import { isPaused } from '../src/services/settings.js';
import { createLogger, type Logger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getItems, getOrder, insertOrder } from './helpers/orders.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';
import { startMockReseller, type MockReseller } from './mocks/reseller-server.js';

const API_KEY = 'mock-key';
const LINK = /https:\/\/mock-reseller\.local\/activate\/[0-9a-f]+/g;

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let mock: MockReseller;
let tg: FakePort;
let alerts: Alert[];
let changed: string[];

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  mock = await startMockReseller({ apiKey: API_KEY });
  tg = fakePort();
  alerts = [];
  changed = [];
});
afterEach(async () => {
  await mock.close();
});

function deps(overrides: { apiKey?: string; logger?: Logger } = {}): FulfilmentDeps {
  const logger = overrides.logger ?? createLogger({ level: 'silent' });
  return {
    db: testDb.db,
    reseller: new ResellerClient({
      baseUrl: mock.url,
      apiKey: overrides.apiKey ?? API_KEY,
      productId: 1,
      maxQtyPerOrder: 10,
      logger,
      timeoutMs: 1_000,
      backoffMs: 1,
      pollIntervalMs: 5,
      pendingTimeoutMs: 500,
    }),
    productId: 1,
    port: tg.port,
    facts,
    notify: (alert) => alerts.push(alert),
    logger,
    onChange: (orderId) => changed.push(orderId),
    itemRetryDelaysMs: [1, 1],
  };
}

const postsFor = (key: string) => mock.orderRequests().filter((r) => r.idempotencyKey === key).length;
const linksIn = (text: string | undefined) => text?.match(LINK) ?? [];

describe('fulfil', () => {
  it('1 link end to end: a paid order becomes delivered with one tap-to-copy link', async () => {
    const id = await insertOrder(testDb.db, { quantity: 1 });
    expect(await fulfil(deps(), id)).toBe('delivered');

    const order = await getOrder(testDb.db, id);
    expect(order.status).toBe('delivered');
    expect(order.deliveredAt).toBeInstanceOf(Date);
    expect(order.fulfilLeaseUntil).toBeNull();

    const [item] = await getItems(testDb.db, id);
    expect(item).toMatchObject({ status: 'completed', idempotencyKey: `${id}-0`, attempts: 1 });
    expect(item?.deliveredAt).toBeInstanceOf(Date);

    expect(tg.sent).toHaveLength(1);
    const [message] = tg.sent;
    expect(message).toMatchObject({ chatId: 42, html: true });
    expect(message?.text).toBe(
      [
        `payment confirmed ✅ order ${order.orderNo}`,
        'your link, tap to copy:',
        `<code>${item?.activationLink}</code>`,
        "open the browser where you're already signed in to the google account you want it on, paste the link and activate it.",
        '⚠️ this link expires soon, so activate it now. if it expires before you activate it, there is no refund.',
        "once it's activated, tap ✅ below and i'll close it here.",
      ].join('\n'),
    );
    expect(tg.buttons(message?.id).map((b) => b.text)).toEqual(["\u2705 i've activated it", 'need help', 'invite & earn \ud83c\udf81']);
    expect(mock.state.orders).toHaveLength(1);
    // claimed, then delivered: the status message is refreshed both times
    expect(changed).toEqual([id, id]);
  });

  it('3 links where item 2 fails: 1 and 3 delivered, order partial, alert, retry completes it without rebuying', async () => {
    const id = await insertOrder(testDb.db, { quantity: 3 });
    mock.failNthItem(2);

    expect(await fulfil(deps(), id)).toBe('partial');
    const order = await getOrder(testDb.db, id);
    expect(order.status).toBe('partial');
    let items = await getItems(testDb.db, id);
    expect(items.map((i) => i.status)).toEqual(['completed', 'failed', 'completed']);
    expect(items[1]?.error).toBe('supplier_purchase_failed');
    expect(alerts.map((a) => a.title)).toEqual(['partial order']);

    const first = tg.sent[0]?.text ?? '';
    expect(linksIn(first)).toEqual([items[0]?.activationLink, items[2]?.activationLink]);
    expect(first).toContain(`link 1 of 3\n<code>${items[0]?.activationLink}</code>`);
    expect(first).toContain(`link 3 of 3\n<code>${items[2]?.activationLink}</code>`);
    expect(first).toContain("the other link is being sorted, we'll send it here.");

    mock.clearFailures();
    expect(await fulfil(deps(), id)).toBe('delivered');
    items = await getItems(testDb.db, id);
    expect(items.every((i) => i.status === 'completed' && i.deliveredAt)).toBe(true);
    expect(tg.sent).toHaveLength(2);
    expect(tg.sent[1]?.text).toContain(`more of order ${order.orderNo} is ready ✅`);
    expect(linksIn(tg.sent[1]?.text)).toEqual([items[1]?.activationLink]);

    expect(mock.state.orders).toHaveLength(3);
    expect(postsFor(itemIdempotencyKey(id, 0))).toBe(1);
    expect(postsFor(itemIdempotencyKey(id, 2))).toBe(1);
  });

  it('running fulfil twice concurrently buys each item once', async () => {
    const id = await insertOrder(testDb.db, { quantity: 3 });
    const outcomes = await Promise.all([fulfil(deps(), id), fulfil(deps(), id)]);
    expect(outcomes.sort()).toEqual(['delivered', 'not_claimed']);
    expect(mock.state.orders).toHaveLength(3);
    for (let idx = 0; idx < 3; idx++) expect(postsFor(itemIdempotencyKey(id, idx))).toBe(1);
    expect(tg.sent).toHaveLength(1);
  });

  it('crash simulation: an expired lease lets a second run finish without duplicate purchases', async () => {
    // A run bought link 1 at the reseller, then died before saving it, while holding the lease.
    const id = await insertOrder(testDb.db, {
      status: 'fulfilling',
      quantity: 2,
      paid: true,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await testDb.db.insert(orderItems).values([
      { orderId: id, idx: 0, idempotencyKey: itemIdempotencyKey(id, 0) },
      { orderId: id, idx: 1, idempotencyKey: itemIdempotencyKey(id, 1) },
    ]);
    const boughtBeforeCrash = await deps().reseller.createOrder(1, itemIdempotencyKey(id, 0));
    expect(mock.state.orders).toHaveLength(1);

    // While the lease is live, nobody else may touch the order.
    expect(await fulfil(deps(), id)).toBe('not_claimed');

    await testDb.db
      .update(orders)
      .set({ fulfilLeaseUntil: sql`now() - interval '1 minute'` })
      .where(eq(orders.id, id));
    expect(await fulfil(deps(), id)).toBe('delivered');

    expect(mock.state.orders).toHaveLength(2);
    const items = await getItems(testDb.db, id);
    expect(items[0]?.activationLink).toBe(boughtBeforeCrash.value);
    expect(linksIn(tg.sent[0]?.text)).toHaveLength(2);
  });

  it('splits many links over several messages under the Telegram limit, each link button with its link', async () => {
    const id = await insertOrder(testDb.db, { quantity: 10 });
    // Long links push the order past 4096 characters.
    await testDb.db.insert(orderItems).values(
      Array.from({ length: 10 }, (_, idx) => ({
        orderId: id,
        idx,
        idempotencyKey: itemIdempotencyKey(id, idx),
        status: 'completed' as const,
        activationLink: `https://one.google.com/activate/${idx}-${'x'.repeat(500)}`,
      })),
    );
    expect(await fulfil(deps(), id)).toBe('delivered');
    expect(tg.sent.length).toBeGreaterThan(1);
    for (const m of tg.sent) expect(m.text.length).toBeLessThanOrEqual(4096);
    expect(tg.sent.flatMap((m) => m.text.match(/link \d+ of 10/g) ?? [])).toHaveLength(10);
    // Every message carries the ✅ buttons of exactly the links it shows; support goes on the last.
    for (const m of tg.sent) {
      const shown = (m.text.match(/link (\d+) of 10/g) ?? []).map((s) => s.replace(' of 10', ''));
      const taps = tg.buttons(m.id).filter((b) => b.text.startsWith('✅')).map((b) => b.text.replace(/^✅ | activated$/g, ''));
      expect(taps).toEqual(shown);
    }
    expect(tg.sent.slice(0, -1).every((m) => !tg.buttons(m.id).some((b) => b.text === 'invite & earn \ud83c\udf81'))).toBe(true);
    expect(tg.buttons(tg.sent.at(-1)?.id).map((b) => b.text)).toContain('invite & earn \ud83c\udf81');
    const items = await getItems(testDb.db, id);
    expect(items.every((i) => i.deliveredAt)).toBe(true);
    // ...and each link remembers the one message that shows it
    expect(items.every((i) => i.messageIds.length === 1 && tg.get(i.messageIds[0])?.text.includes(`link ${i.idx + 1} of 10`))).toBe(true);
  });

  it('escapes html in links', async () => {
    const id = await insertOrder(testDb.db, { quantity: 1 });
    await testDb.db.insert(orderItems).values({
      orderId: id,
      idx: 0,
      idempotencyKey: itemIdempotencyKey(id, 0),
      status: 'completed',
      activationLink: 'https://x.test/a?b=1&c=<d>',
    });
    await fulfil(deps(), id);
    expect(tg.sent[0]?.text).toContain('<code>https://x.test/a?b=1&amp;c=&lt;d&gt;</code>');
    expect((await getItems(testDb.db, id))[0]?.deliveredAt).toBeInstanceOf(Date);
  });

  it('nothing bought: needs_attention, owner alerted, buyer told once, completes after a restock', async () => {
    const id = await insertOrder(testDb.db, { quantity: 2 });
    mock.set({ stock: 0 });

    expect(await fulfil(deps(), id)).toBe('needs_attention');
    expect((await getOrder(testDb.db, id)).error).toContain('out_of_stock');
    expect(alerts).toMatchObject([{ level: 'critical', title: 'paid order not fulfilled' }]);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.text).toContain('taking a little longer than usual');
    expect(linksIn(tg.sent[0]?.text)).toEqual([]);

    // A retry that still fails does not message the buyer again.
    expect(await fulfil(deps(), id)).toBe('needs_attention');
    expect(tg.sent).toHaveLength(1);

    mock.set({ stock: 10 });
    expect(await fulfil(deps(), id)).toBe('delivered');
    expect(tg.sent[1]?.text).toContain('your links, tap to copy:');
  });

  it('a buyer who blocked the bot: needs_attention, alert, links kept for support', async () => {
    const id = await insertOrder(testDb.db, { quantity: 1 });
    tg.block(42);

    expect(await fulfil(deps(), id)).toBe('needs_attention');
    expect((await getOrder(testDb.db, id)).error).toContain('blocked');
    const [item] = await getItems(testDb.db, id);
    expect(item?.activationLink).toMatch(LINK);
    expect(item?.deliveredAt).toBeNull();
    const [user] = await testDb.db.select().from(users).where(eq(users.telegramId, 42));
    expect(user?.blocked).toBe(true);
    expect(alerts.map((a) => a.title)).toEqual(['could not deliver links']);
  });

  it('a transient send failure hands the order back, and the retry delivers without rebuying', async () => {
    const id = await insertOrder(testDb.db, { quantity: 1 });
    tg.failNextSends(1);
    expect(await fulfil(deps(), id)).toBe('delivery_failed');
    expect((await getOrder(testDb.db, id)).status).toBe('paid');

    expect(await fulfil(deps(), id)).toBe('delivered');
    expect(mock.state.orders).toHaveLength(1);
    expect(tg.sent).toHaveLength(1);
  });

  it('never fulfils a payment held for review (paid_at is null)', async () => {
    const id = await insertOrder(testDb.db, { status: 'needs_attention', paid: false });
    expect(await fulfil(deps(), id)).toBe('not_claimed');
    expect(mock.orderRequests()).toHaveLength(0);
  });

  it('a rejected reseller API key pauses sales and alerts', async () => {
    const id = await insertOrder(testDb.db, { quantity: 3 });
    expect(await fulfil(deps({ apiKey: 'wrong' }), id)).toBe('needs_attention');
    expect(await isPaused(testDb.db)).toBe(true);
    expect(alerts.map((a) => a.title)).toContain('reseller api key rejected');
    // Stops at the first rejection instead of trying every link.
    expect(mock.orderRequests()).toHaveLength(1);
  });

  it('never writes an activation link to the logs', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', destination: { write: (line: string) => lines.push(line) } });
    const id = await insertOrder(testDb.db, { quantity: 2 });
    mock.failNthItem(2);
    await fulfil(deps({ logger }), id);
    mock.clearFailures();
    await fulfil(deps({ logger }), id);

    const output = lines.join('');
    expect(output).toContain(id);
    expect(output).toContain('link bought');
    expect(output).not.toMatch(LINK);
  });
});

import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { events, orders, users, type OrderStatus } from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { BachsError, type CheckoutSession } from '../src/services/bachs.js';
import type { Alert } from '../src/services/notifier.js';
import { paymentReference } from '../src/services/orders.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';

const SECRET = 'whsec_route_test';
const logger = createLogger({ level: 'silent' });

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let alerts: Alert[];
let paid: string[];
let checkout: CheckoutSession | Error;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  alerts = [];
  paid = [];
  app = buildServer({
    logger,
    pingDb: async () => {},
    bachsWebhook: {
      db: testDb.db,
      bachs: {
        getCheckout: async () => {
          if (checkout instanceof Error) throw checkout;
          return checkout;
        },
      },
      webhookSecret: SECRET,
      notify: (alert) => alerts.push(alert),
      onPaid: (orderId) => {
        paid.push(orderId);
      },
    },
  });
});

async function createOrder(status: OrderStatus = 'awaiting_payment', amountNgn = 3500) {
  const id = randomUUID();
  await testDb.db.insert(users).values({ telegramId: 42 }).onConflictDoNothing();
  await testDb.db.insert(orders).values({
    id,
    telegramId: 42,
    quantity: 1,
    unitPriceNgn: 3500,
    amountNgn,
    status,
    paymentReference: paymentReference(id),
    checkoutId: `chk_${id.slice(0, 8)}`,
  });
  checkout = {
    checkoutId: `chk_${id.slice(0, 8)}`,
    status: 'completed',
    paymentStatus: 'succeeded',
    amountMinor: amountNgn * 100,
    currency: 'NGN',
    reference: paymentReference(id),
  };
  return { id, reference: paymentReference(id), checkoutId: `chk_${id.slice(0, 8)}` };
}

function eventBody(order: { reference: string; checkoutId: string }, id = 'evt_1', type = 'checkout.completed') {
  return JSON.stringify({
    id,
    type,
    created_at: new Date().toISOString(),
    organization_id: 'acct_test',
    data: { checkout_id: order.checkoutId, reference: order.reference, status: 'completed', amount: '3500.00', currency: 'NGN' },
  });
}

function deliver(body: string, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return app.inject({
    method: 'POST',
    url: '/bachs/webhook',
    headers: { 'content-type': 'application/json', 'x-bachs-signature-v2': `t=${timestamp},v1=${signature}` },
    payload: body,
  });
}

async function orderRow(id: string) {
  const [row] = await testDb.db.select().from(orders).where(eq(orders.id, id));
  return row;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('POST /bachs/webhook', () => {
  it('accepts a validly signed payment, marks the order paid and triggers fulfilment once', async () => {
    const order = await createOrder();
    const res = await deliver(eventBody(order));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: 'paid' });

    const row = await orderRow(order.id);
    expect(row?.status).toBe('paid');
    expect(row?.paidAt).toBeInstanceOf(Date);
    await flush();
    expect(paid).toEqual([order.id]);
  });

  it('rejects a tampered body with 401 and raises an alert', async () => {
    const order = await createOrder();
    const body = eventBody(order);
    const signature = createHmac('sha256', SECRET).update(`${Math.floor(Date.now() / 1000)}.${body}`).digest('hex');
    const res = await app.inject({
      method: 'POST',
      url: '/bachs/webhook',
      headers: {
        'content-type': 'application/json',
        'x-bachs-signature-v2': `t=${Math.floor(Date.now() / 1000)},v1=${signature}`,
      },
      payload: body.replace('"amount":"3500.00"', '"amount":"9999.00"'),
    });
    expect(res.statusCode).toBe(401);
    expect(alerts.map((a) => a.title)).toEqual(['webhook signature failure']);
    expect((await orderRow(order.id))?.status).toBe('awaiting_payment');
  });

  it('rejects a wrong secret and a replayed old delivery', async () => {
    const order = await createOrder();
    expect((await deliver(eventBody(order), { secret: 'not-the-secret' })).statusCode).toBe(401);
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    expect((await deliver(eventBody(order), { timestamp: tenMinutesAgo })).statusCode).toBe(401);
    expect((await orderRow(order.id))?.status).toBe('awaiting_payment');
  });

  it('a duplicate delivery does not transition twice', async () => {
    const order = await createOrder();
    const body = eventBody(order, 'evt_dup');
    expect((await deliver(body)).json()).toEqual({ ok: true, result: 'paid' });
    expect((await deliver(body)).json()).toEqual({ ok: true, result: 'duplicate' });
    await flush();
    expect(paid).toEqual([order.id]);
    const rows = await testDb.db.select().from(events).where(eq(events.ref, 'evt_dup'));
    expect(rows).toHaveLength(1);
  });

  it('checkout.completed and collection.succeeded for one payment fulfil once', async () => {
    const order = await createOrder();
    const [a, b] = await Promise.all([
      deliver(eventBody(order, 'evt_a', 'checkout.completed')),
      deliver(eventBody(order, 'evt_b', 'collection.succeeded')),
    ]);
    expect([a.json().result, b.json().result].sort()).toEqual(['already_handled', 'paid']);
    await flush();
    expect(paid).toEqual([order.id]);
  });

  it('an amount below the order does not mark paid, holds the order and raises an alert', async () => {
    const order = await createOrder();
    checkout = { ...(checkout as CheckoutSession), amountMinor: 3000_00 };
    const res = await deliver(eventBody(order));
    expect(res.json()).toEqual({ ok: true, result: 'held' });

    const row = await orderRow(order.id);
    expect(row?.status).toBe('needs_attention');
    expect(row?.paidAt).toBeNull();
    expect(row?.error).toContain('below the order amount');
    expect(alerts).toMatchObject([{ level: 'critical', title: 'payment held for review' }]);
    await flush();
    expect(paid).toEqual([]);
  });

  it('holds a payment in the wrong currency or for another reference', async () => {
    const order = await createOrder();
    checkout = { ...(checkout as CheckoutSession), currency: 'USD' };
    expect((await deliver(eventBody(order, 'evt_usd'))).json().result).toBe('held');

    const other = await createOrder();
    checkout = { ...(checkout as CheckoutSession), reference: 'gp_someone_else' };
    expect((await deliver(eventBody(other, 'evt_ref'))).json().result).toBe('held');
  });

  it('accepts a late payment on an expired order', async () => {
    const order = await createOrder('expired');
    expect((await deliver(eventBody(order))).json()).toEqual({ ok: true, result: 'paid' });
    expect((await orderRow(order.id))?.status).toBe('paid');
  });

  it('asks Bachs to retry while the checkout is not completed, then pays on the retry', async () => {
    const order = await createOrder();
    checkout = { ...(checkout as CheckoutSession), status: 'open' };
    const first = await deliver(eventBody(order, 'evt_retry'));
    expect(first.statusCode).toBe(503);
    expect((await orderRow(order.id))?.status).toBe('awaiting_payment');

    checkout = { ...(checkout as CheckoutSession), status: 'completed' };
    expect((await deliver(eventBody(order, 'evt_retry'))).json()).toEqual({ ok: true, result: 'paid' });
  });

  it('asks Bachs to retry when the checkout cannot be verified', async () => {
    const order = await createOrder();
    checkout = new BachsError('timeout', 'timed out');
    expect((await deliver(eventBody(order))).statusCode).toBe(503);
    expect((await orderRow(order.id))?.status).toBe('awaiting_payment');
  });

  it('ignores an order that is already past payment', async () => {
    const order = await createOrder('delivered');
    expect((await deliver(eventBody(order))).json()).toEqual({ ok: true, result: 'already_handled' });
    expect((await orderRow(order.id))?.status).toBe('delivered');
  });

  it('ignores unrelated events and alerts on payments for unknown orders', async () => {
    const order = await createOrder();
    expect((await deliver(eventBody(order, 'evt_x', 'checkout.expired'))).json()).toEqual({ ok: true, result: 'ignored' });
    expect((await orderRow(order.id))?.status).toBe('awaiting_payment');

    const unknown = { reference: 'gp_nope', checkoutId: 'chk_nope' };
    expect((await deliver(eventBody(unknown, 'evt_y'))).json()).toEqual({ ok: true, result: 'unknown_order' });
    expect(alerts.map((a) => a.title)).toEqual(['payment for unknown order']);
  });

  it('returns 400 for a signed body that is not a Bachs event', async () => {
    expect((await deliver('{"hello":"world"}')).statusCode).toBe(400);
  });

  it('answers 503 so Bachs retries when no webhook secret is configured', async () => {
    const order = await createOrder();
    const unconfigured = buildServer({
      logger,
      pingDb: async () => {},
      bachsWebhook: {
        db: testDb.db,
        bachs: { getCheckout: async () => checkout as CheckoutSession },
        webhookSecret: undefined,
        notify: (alert) => alerts.push(alert),
        onPaid: () => {},
      },
    });
    const res = await unconfigured.inject({
      method: 'POST',
      url: '/bachs/webhook',
      headers: { 'content-type': 'application/json' },
      payload: eventBody(order),
    });
    await unconfigured.close();
    expect(res.statusCode).toBe(503);
    expect((await orderRow(order.id))?.status).toBe('awaiting_payment');
  });
});

describe('bachs webhook logging', () => {
  it('logs the order but never the signing secret or the signature', async () => {
    const lines: string[] = [];
    const capture = createLogger({ level: 'debug', destination: { write: (line: string) => lines.push(line) } });
    const order = await createOrder();
    const server = buildServer({
      logger: capture,
      pingDb: async () => {},
      bachsWebhook: {
        db: testDb.db,
        bachs: { getCheckout: async () => checkout as CheckoutSession },
        webhookSecret: SECRET,
        notify: () => {},
        onPaid: () => {},
      },
    });
    const body = eventBody(order);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    await server.inject({
      method: 'POST',
      url: '/bachs/webhook',
      headers: { 'content-type': 'application/json', 'x-bachs-signature-v2': `t=${timestamp},v1=${signature}` },
      payload: body,
    });
    await server.close();

    const output = lines.join('');
    expect(output).toContain(order.id);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(signature);
  });
});

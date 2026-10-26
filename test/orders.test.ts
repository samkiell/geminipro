import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { orderItems } from '../src/db/schema.js';
import type { CreateCheckoutInput } from '../src/services/bachs.js';
import {
  cancelPendingOrder,
  createOrder,
  expireUnpaidOrders,
  reservedUnits,
  type CreateOrderDeps,
} from '../src/services/orders.js';
import { computeAvailability } from '../src/services/reseller.js';
import { setPaused } from '../src/services/settings.js';
import { createTestDb } from './helpers/db.js';
import { getOrder, insertOrder } from './helpers/orders.js';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let checkouts: CreateCheckoutInput[];
let reservedSeen: number[];
let balanceCents: number;
let checkoutFails: boolean;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  checkouts = [];
  reservedSeen = [];
  balanceCents = 10_000;
  checkoutFails = false;
});

function deps(overrides: Partial<CreateOrderDeps> = {}): CreateOrderDeps {
  return {
    db: testDb.db,
    reseller: {
      getAvailability: async (reserved) => {
        reservedSeen.push(reserved);
        return computeAvailability({
          balanceCents,
          priceCents: 120,
          stock: 100,
          inStock: true,
          reservedUnits: reserved,
          maxQtyPerOrder: 10,
        });
      },
    },
    payments: {
      createCheckout: async (input: CreateCheckoutInput) => {
        checkouts.push(input);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (checkoutFails) throw new Error('bachs down');
        return {
          checkoutId: `chk_${input.orderId.slice(0, 8)}`,
          checkoutUrl: `https://sandbox-checkout.bachs.io/c/${input.orderId.slice(0, 8)}`,
          expiresAt: undefined,
        };
      },
    },
    pricing: { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 },
    maxQtyPerOrder: 10,
    salesCutoff: undefined,
    returnUrl: 'https://t.me/geminiprosamkiel_bot',
    ...overrides,
  };
}

describe('createOrder', () => {
  it('creates an awaiting_payment order with a Bachs checkout', async () => {
    const result = await createOrder(deps(), { telegramId: 7, quantity: 3 });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);

    const { order } = result;
    expect(order).toMatchObject({
      telegramId: 7,
      quantity: 3,
      unitPriceNgn: 3500,
      feeNgn: 0,
      amountNgn: 10_500,
      status: 'awaiting_payment',
      paymentReference: `gp_${order.id}`,
      checkoutId: `chk_${order.id.slice(0, 8)}`,
    });
    expect(result.checkoutUrl).toBe(order.checkoutUrl);
    const minutesLeft = ((order.expiresAt?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(14);
    expect(minutesLeft).toBeLessThanOrEqual(15);

    expect(checkouts).toEqual([
      {
        orderId: order.id,
        reference: `gp_${order.id}`,
        amountNgn: 10_500,
        quantity: 3,
        telegramId: 7,
        expiresInMinutes: 15,
        returnUrl: 'https://t.me/geminiprosamkiel_bot',
      },
    ]);
  });

  it("stores the provider's checkout expiry, never an assumed window", async () => {
    const expiresAt = new Date(Date.now() + 9 * 60_000);
    const result = await createOrder(
      deps({
        paymentWindowMinutes: 20,
        payments: {
          createCheckout: async (input: CreateCheckoutInput) => {
            checkouts.push(input);
            return { checkoutId: 'chk_x', checkoutUrl: 'https://sandbox-checkout.bachs.io/c/x', expiresAt };
          },
        },
      }),
      { telegramId: 7, quantity: 1 },
    );
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(checkouts[0]?.expiresInMinutes).toBe(20);
    expect(result.order.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('stores the grossed up total when the bot adds the fee', async () => {
    const result = await createOrder(
      deps({ pricing: { unitPriceNgn: 3500, grossUp: true, feePct: 0.02, feeFlat: 0 } }),
      { telegramId: 7, quantity: 3 },
    );
    expect(result.ok && result.order).toMatchObject({ amountNgn: 10_715, feeNgn: 215 });
    expect(checkouts[0]?.amountNgn).toBe(10_715);
  });

  it('refuses quantities outside 1..MAX_QTY_PER_ORDER', async () => {
    for (const quantity of [0, 11, 1.5]) {
      expect(await createOrder(deps(), { telegramId: 7, quantity })).toEqual({
        ok: false,
        reason: 'invalid_quantity',
        maxQuantity: 10,
      });
    }
    expect(checkouts).toHaveLength(0);
  });

  it('refuses while sales are paused', async () => {
    await setPaused(testDb.db, true);
    expect(await createOrder(deps(), { telegramId: 7, quantity: 1 })).toEqual({ ok: false, reason: 'paused' });
    await setPaused(testDb.db, false);
    expect((await createOrder(deps(), { telegramId: 7, quantity: 1 })).ok).toBe(true);
  });

  it('refuses after SALES_CUTOFF', async () => {
    const result = await createOrder(deps({ salesCutoff: new Date(Date.now() - 1_000) }), { telegramId: 7, quantity: 1 });
    expect(result).toEqual({ ok: false, reason: 'closed' });
  });

  it('allows one unpaid order per user and returns the existing one', async () => {
    const first = await createOrder(deps(), { telegramId: 7, quantity: 1 });
    const second = await createOrder(deps(), { telegramId: 7, quantity: 2 });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toBe('pending_exists');
    expect(!second.ok && second.reason === 'pending_exists' && second.order.id).toBe(first.ok && first.order.id);
    expect((await createOrder(deps(), { telegramId: 8, quantity: 1 })).ok).toBe(true);
  });

  it('two simultaneous requests from one user create only one order', async () => {
    const results = await Promise.all([
      createOrder(deps(), { telegramId: 7, quantity: 1 }),
      createOrder(deps(), { telegramId: 7, quantity: 1 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'pending_exists')).toHaveLength(1);
  });

  it('sets aside links already promised to unpaid and paid-but-unbought orders', async () => {
    await insertOrder(testDb.db, { status: 'paid', quantity: 2, telegramId: 1 });
    const partial = await insertOrder(testDb.db, { status: 'partial', quantity: 3, telegramId: 2 });
    await testDb.db.insert(orderItems).values({
      orderId: partial,
      idx: 0,
      idempotencyKey: `${partial}-0`,
      status: 'completed',
      activationLink: 'https://x',
    });
    await insertOrder(testDb.db, { status: 'awaiting_payment', quantity: 1, telegramId: 3 });
    await insertOrder(testDb.db, { status: 'awaiting_payment', quantity: 5, telegramId: 4, expiresAt: new Date(0) });
    await insertOrder(testDb.db, { status: 'delivered', quantity: 4, telegramId: 5 });
    await insertOrder(testDb.db, { status: 'needs_attention', quantity: 1, telegramId: 6, paid: false });

    // paid 2 + partial 3 - 1 bought + live unpaid 1; expired, delivered and held orders do not count.
    expect(await reservedUnits(testDb.db)).toBe(5);

    // $8.40 covers 7 links; 5 are promised, so 2 can still be sold.
    balanceCents = 840;
    const tooMany = await createOrder(deps(), { telegramId: 7, quantity: 3 });
    expect(tooMany).toEqual({ ok: false, reason: 'unavailable', maxQuantity: 2 });
    expect(reservedSeen).toEqual([5]);
    expect((await createOrder(deps(), { telegramId: 7, quantity: 2 })).ok).toBe(true);
  });

  it('does not sell when the reseller cannot be reached', async () => {
    const result = await createOrder(
      deps({
        reseller: {
          getAvailability: async () => {
            throw new Error('timeout');
          },
        },
      }),
      { telegramId: 7, quantity: 1 },
    );
    expect(result).toEqual({ ok: false, reason: 'unavailable', maxQuantity: 0 });
  });

  it('cancels the order when the checkout cannot be created, so the buyer can try again', async () => {
    checkoutFails = true;
    expect(await createOrder(deps(), { telegramId: 7, quantity: 1 })).toEqual({ ok: false, reason: 'checkout_failed' });
    checkoutFails = false;
    const retry = await createOrder(deps(), { telegramId: 7, quantity: 1 });
    expect(retry.ok).toBe(true);
    const failedId = checkouts[0]?.orderId ?? '';
    expect((await getOrder(testDb.db, failedId)).status).toBe('cancelled');
  });

  it('expires a stale unpaid order so the buyer can start a new one', async () => {
    const stale = await insertOrder(testDb.db, { status: 'awaiting_payment', telegramId: 7, expiresAt: new Date(0) });
    expect((await createOrder(deps(), { telegramId: 7, quantity: 1 })).ok).toBe(true);
    expect((await getOrder(testDb.db, stale)).status).toBe('expired');
  });
});

describe('cancel and expire', () => {
  it('cancelPendingOrder cancels only the unpaid order', async () => {
    const paid = await insertOrder(testDb.db, { status: 'paid', telegramId: 7 });
    const pending = await insertOrder(testDb.db, { status: 'awaiting_payment', telegramId: 7 });
    expect((await cancelPendingOrder(testDb.db, 7))?.id).toBe(pending);
    expect(await cancelPendingOrder(testDb.db, 7)).toBeUndefined();
    expect((await getOrder(testDb.db, paid)).status).toBe('paid');
  });

  it('expireUnpaidOrders only expires orders past their window', async () => {
    const old = await insertOrder(testDb.db, { status: 'awaiting_payment', telegramId: 1, expiresAt: new Date(0) });
    const fresh = await insertOrder(testDb.db, { status: 'awaiting_payment', telegramId: 2 });
    expect((await expireUnpaidOrders(testDb.db)).map((o) => o.id)).toEqual([old]);
    expect((await getOrder(testDb.db, fresh)).status).toBe('awaiting_payment');
  });
});

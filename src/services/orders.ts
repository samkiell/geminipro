import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { orderItems, orders, users, type Order, type OrderStatus } from '../db/schema.js';
import type { PaymentProvider } from './payments.js';
import { priceFor, type Price, type PricingConfig } from './pricing.js';
import type { ResellerClient } from './reseller.js';
import { isPaused } from './settings.js';

// Every state change is a conditional UPDATE: it only applies if the order is still in an
// expected state, so concurrent webhooks, retries and the reconciler cannot double-apply it.

export const PAYMENT_WINDOW_MINUTES = 15;

/**
 * Orders a payment can still settle. A payment that lands after expiry or after the buyer
 * cancelled is honoured anyway: the money has already moved.
 */
export const PAYABLE: readonly OrderStatus[] = ['created', 'awaiting_payment', 'expired', 'cancelled'];

export const UNPAID_OPEN: readonly OrderStatus[] = ['created', 'awaiting_payment'];

export function paymentReference(orderId: string): string {
  return `gp_${orderId}`;
}

// ---------------------------------------------------------------- creating orders

export interface CreateOrderDeps {
  db: Db;
  reseller: Pick<ResellerClient, 'getAvailability'>;
  payments: Pick<PaymentProvider, 'createCheckout'>;
  pricing: PricingConfig;
  maxQtyPerOrder: number;
  salesCutoff: Date | undefined;
  /** Where the buyer lands after paying, e.g. the bot's t.me link. */
  returnUrl: string | undefined;
  now?: () => Date;
}

export type CreateOrderResult =
  | { ok: true; order: Order; checkoutUrl: string; price: Price }
  | { ok: false; reason: 'invalid_quantity'; maxQuantity: number }
  | { ok: false; reason: 'paused' | 'closed' | 'checkout_failed' }
  | { ok: false; reason: 'pending_exists'; order: Order }
  | { ok: false; reason: 'unavailable'; maxQuantity: number };

/**
 * Creates an order and its Bachs checkout, after the pre-sale checks: sales not paused, before
 * SALES_CUTOFF, no other unpaid order for this user, and enough stock and balance once links
 * already promised to other orders are set aside. The order is saved before Bachs is called.
 */
export async function createOrder(
  deps: CreateOrderDeps,
  input: { telegramId: number; quantity: number },
): Promise<CreateOrderResult> {
  const { db } = deps;
  const { telegramId, quantity } = input;
  const now = deps.now?.() ?? new Date();

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > deps.maxQtyPerOrder) {
    return { ok: false, reason: 'invalid_quantity', maxQuantity: deps.maxQtyPerOrder };
  }
  if (await isPaused(db)) return { ok: false, reason: 'paused' };
  if (deps.salesCutoff && now >= deps.salesCutoff) return { ok: false, reason: 'closed' };

  await db.insert(users).values({ telegramId }).onConflictDoNothing();
  await expireUnpaidOrders(db, telegramId);
  const pending = await findPendingOrder(db, telegramId);
  if (pending) return { ok: false, reason: 'pending_exists', order: pending };

  let maxQuantity: number;
  try {
    ({ maxQuantity } = await deps.reseller.getAvailability(await reservedUnits(db)));
  } catch {
    // Cannot confirm stock or balance, so do not take money.
    return { ok: false, reason: 'unavailable', maxQuantity: 0 };
  }
  if (quantity > maxQuantity) return { ok: false, reason: 'unavailable', maxQuantity };

  const price = priceFor(quantity, deps.pricing);
  const id = randomUUID();
  try {
    await db.insert(orders).values({
      id,
      telegramId,
      quantity,
      unitPriceNgn: price.unitPriceNgn,
      feeNgn: price.feeNgn,
      amountNgn: price.totalNgn,
      status: 'created',
      paymentReference: paymentReference(id),
      expiresAt: sql`now() + make_interval(mins => ${PAYMENT_WINDOW_MINUTES})`,
    });
  } catch (err) {
    // Another request for this user won the one-unpaid-order race.
    if (!isUniqueViolation(err)) throw err;
    const winner = await findPendingOrder(db, telegramId);
    if (winner) return { ok: false, reason: 'pending_exists', order: winner };
    throw err;
  }

  try {
    const checkout = await deps.payments.createCheckout({
      orderId: id,
      reference: paymentReference(id),
      amountNgn: price.totalNgn,
      quantity,
      telegramId,
      expiresInMinutes: PAYMENT_WINDOW_MINUTES,
      ...(deps.returnUrl && { returnUrl: deps.returnUrl }),
    });
    const [order] = await db
      .update(orders)
      .set({ status: 'awaiting_payment', checkoutId: checkout.checkoutId, checkoutUrl: checkout.checkoutUrl })
      .where(and(eq(orders.id, id), eq(orders.status, 'created')))
      .returning();
    if (!order) return { ok: false, reason: 'checkout_failed' };
    return { ok: true, order, checkoutUrl: checkout.checkoutUrl, price };
  } catch (err) {
    await db
      .update(orders)
      .set({ status: 'cancelled', error: `checkout failed: ${(err as Error).message}` })
      .where(and(eq(orders.id, id), eq(orders.status, 'created')));
    return { ok: false, reason: 'checkout_failed' };
  }
}

export async function findPendingOrder(db: Db, telegramId: number): Promise<Order | undefined> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.telegramId, telegramId), inArray(orders.status, UNPAID_OPEN)))
    .limit(1);
  return order;
}

/**
 * Links promised but not yet bought: unpaid orders still inside their payment window, and paid
 * orders that are not fully fulfilled. They need stock and reseller balance just like a new order.
 */
export async function reservedUnits(db: Db): Promise<number> {
  const open = or(
    inArray(orders.status, ['paid', 'fulfilling', 'partial']),
    and(eq(orders.status, 'needs_attention'), isNotNull(orders.paidAt)),
    and(inArray(orders.status, UNPAID_OPEN), sql`${orders.expiresAt} > now()`),
  );
  const [ordered] = await db
    .select({ units: sql<number>`coalesce(sum(${orders.quantity}), 0)::int` })
    .from(orders)
    .where(open);
  const [bought] = await db
    .select({ units: sql<number>`count(*)::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(open, eq(orderItems.status, 'completed')));
  return (ordered?.units ?? 0) - (bought?.units ?? 0);
}

/** created | awaiting_payment -> cancelled for this user. A payment that still lands is honoured. */
export async function cancelPendingOrder(db: Db, telegramId: number): Promise<Order | undefined> {
  const [order] = await db
    .update(orders)
    .set({ status: 'cancelled' })
    .where(and(eq(orders.telegramId, telegramId), inArray(orders.status, UNPAID_OPEN)))
    .returning();
  return order;
}

/** created | awaiting_payment past their payment window -> expired (all users, or one). */
export async function expireUnpaidOrders(db: Db, telegramId?: number): Promise<Order[]> {
  const conditions: SQL[] = [inArray(orders.status, UNPAID_OPEN), sql`${orders.expiresAt} < now()`];
  if (telegramId !== undefined) conditions.push(eq(orders.telegramId, telegramId));
  return db
    .update(orders)
    .set({ status: 'expired' })
    .where(and(...conditions))
    .returning();
}

// ---------------------------------------------------------------- payment

export async function findOrderForPayment(
  db: Db,
  { reference, checkoutId }: { reference?: string | undefined; checkoutId?: string | undefined },
): Promise<Order | undefined> {
  const matches: SQL[] = [];
  if (reference) matches.push(eq(orders.paymentReference, reference));
  if (checkoutId) matches.push(eq(orders.checkoutId, checkoutId));
  if (matches.length === 0) return undefined;
  const [order] = await db
    .select()
    .from(orders)
    .where(or(...matches))
    .limit(1);
  return order;
}

/** PAYABLE -> paid. Returns the order only if this call made the change. */
export async function markPaid(db: Db, orderId: string): Promise<Order | undefined> {
  const [order] = await db
    .update(orders)
    .set({ status: 'paid', paidAt: sql`now()`, error: null })
    .where(and(eq(orders.id, orderId), inArray(orders.status, PAYABLE)))
    .returning();
  return order;
}

/** PAYABLE -> needs_attention, for a payment that did not match the order. paid_at stays null. */
export async function holdPayment(db: Db, orderId: string, reason: string): Promise<Order | undefined> {
  const [order] = await db
    .update(orders)
    .set({ status: 'needs_attention', error: reason })
    .where(and(eq(orders.id, orderId), inArray(orders.status, PAYABLE)))
    .returning();
  return order;
}

// ---------------------------------------------------------------- fulfilment

export const LEASE_MINUTES = 2;

/**
 * Takes the fulfilment lease. Only paid orders qualify (paid_at set, so a held payment never
 * does): paid, partial, needs_attention, or fulfilling whose lease ran out (a crashed run).
 */
export async function claimForFulfilment(db: Db, orderId: string): Promise<Order | undefined> {
  const [order] = await db
    .update(orders)
    .set({ status: 'fulfilling', fulfilLeaseUntil: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
    .where(
      and(
        eq(orders.id, orderId),
        isNotNull(orders.paidAt),
        or(
          inArray(orders.status, ['paid', 'partial', 'needs_attention']),
          and(eq(orders.status, 'fulfilling'), sql`${orders.fulfilLeaseUntil} < now()`),
        ),
      ),
    )
    .returning();
  return order;
}

/** Extends the lease while a long run is still buying links. */
export async function renewLease(db: Db, orderId: string): Promise<void> {
  await db
    .update(orders)
    .set({ fulfilLeaseUntil: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'fulfilling')));
}

/** fulfilling -> the outcome of this run, releasing the lease. */
export async function finishFulfilment(
  db: Db,
  orderId: string,
  status: Extract<OrderStatus, 'delivered' | 'partial' | 'needs_attention' | 'paid'>,
  error: string | null,
): Promise<Order | undefined> {
  const [order] = await db
    .update(orders)
    .set({
      status,
      error,
      fulfilLeaseUntil: null,
      ...(status === 'delivered' && { deliveredAt: sql`now()` }),
    })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'fulfilling')))
    .returning();
  return order;
}

// ---------------------------------------------------------------- buyer views (ownership checked)

/** An order of this buyer, or nothing. Ids from buttons are never trusted on their own. */
export async function findOwnOrder(db: Db, telegramId: number, orderId: string): Promise<Order | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return undefined;
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.telegramId, telegramId)));
  return order;
}

export async function findOwnOrderByNo(db: Db, telegramId: number, orderNo: string): Promise<Order | undefined> {
  const normalised = orderNo.trim().toUpperCase().replace(/^GP-?/, 'GP-');
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.orderNo, normalised), eq(orders.telegramId, telegramId)));
  return order;
}

export const HISTORY_PAGE_SIZE = 5;

/** Paid orders and the current unpaid one, newest first. Abandoned ones are left out. */
export async function historyPage(
  db: Db,
  telegramId: number,
  page: number,
): Promise<{ orders: Order[]; hasNext: boolean }> {
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.telegramId, telegramId),
        or(isNotNull(orders.paidAt), inArray(orders.status, UNPAID_OPEN)),
      ),
    )
    .orderBy(sql`${orders.createdAt} desc`)
    .limit(HISTORY_PAGE_SIZE + 1)
    .offset((Math.max(page, 1) - 1) * HISTORY_PAGE_SIZE);
  return { orders: rows.slice(0, HISTORY_PAGE_SIZE), hasNext: rows.length > HISTORY_PAGE_SIZE };
}

export async function countPastOrders(db: Db, telegramId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.telegramId, telegramId), isNotNull(orders.paidAt)));
  return row?.n ?? 0;
}

/** Links already sent to the buyer, in order. Sensitive: never log them. */
export async function deliveredLinks(db: Db, orderId: string): Promise<{ number: number; link: string }[]> {
  const rows = await db
    .select({ idx: orderItems.idx, link: orderItems.activationLink })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), isNotNull(orderItems.deliveredAt), isNotNull(orderItems.activationLink)))
    .orderBy(orderItems.idx);
  return rows.map((r) => ({ number: r.idx + 1, link: r.link as string }));
}

export async function setOrderMessages(
  db: Db,
  orderId: string,
  ids: Partial<Pick<Order, 'summaryMessageId' | 'payMessageId' | 'statusMessageId'>>,
): Promise<void> {
  await db.update(orders).set(ids).where(eq(orders.id, orderId));
}

/** One unpaid order of this buyer -> cancelled. A payment that still lands is honoured. */
export async function cancelOwnOrder(db: Db, telegramId: number, orderId: string): Promise<Order | undefined> {
  const [order] = await db
    .update(orders)
    .set({ status: 'cancelled' })
    .where(and(eq(orders.id, orderId), eq(orders.telegramId, telegramId), inArray(orders.status, UNPAID_OPEN)))
    .returning();
  return order;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | undefined)?.code;
  return code(err) === '23505' || code((err as { cause?: unknown } | undefined)?.cause) === '23505';
}

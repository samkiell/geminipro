import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { orderDrafts, orderItems, orders, users, type Order, type OrderDraft, type OrderItem, type OrderStatus } from '../db/schema.js';
import type { PaymentProvider } from './payments.js';
import { priceFor, type Price, type PricingConfig } from './pricing.js';
import type { ResellerClient } from './reseller.js';
import { isPaused } from './settings.js';

// Every state change is a conditional UPDATE: it only applies if the order is still in an
// expected state, so concurrent webhooks, retries and the reconciler cannot double-apply it.

export const PAYMENT_WINDOW_MINUTES = 15;

// Ids that come back from buttons are checked before they reach a query.
const UUID = /^[0-9a-f-]{36}$/i;

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
  /** Session length asked of Bachs, and the expiry used when its response has none. */
  paymentWindowMinutes?: number;
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
  const windowMinutes = deps.paymentWindowMinutes ?? PAYMENT_WINDOW_MINUTES;
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
      expiresAt: sql`now() + make_interval(mins => ${windowMinutes})`,
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
      expiresInMinutes: windowMinutes,
      ...(deps.returnUrl && { returnUrl: deps.returnUrl }),
    });
    const [order] = await db
      .update(orders)
      .set({
        status: 'awaiting_payment',
        checkoutId: checkout.checkoutId,
        checkoutUrl: checkout.checkoutUrl,
        // The provider's expiry is the source of truth for the countdown (Prompt D section 4).
        ...(checkout.expiresAt && !Number.isNaN(checkout.expiresAt.getTime()) && { expiresAt: checkout.expiresAt }),
      })
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
  if (!UUID.test(orderId)) return undefined;
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

/** Admin lookup by order number, any buyer. "GP-1042", "gp1042" and "1042" all work. */
export async function findOrderByNo(db: Db, orderNo: string): Promise<Order | undefined> {
  const digits = /(\d{3,})/.exec(orderNo)?.[1];
  if (!digits) return undefined;
  const [order] = await db.select().from(orders).where(eq(orders.orderNo, `GP-${digits}`));
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
/** A link as the buyer sees it: open (tap to copy) or closed once they marked it activated. */
export interface ShownLink {
  itemId: string;
  /** 1-based position in the order; replacements come after the ordered quantity. */
  number: number;
  link: string;
  activatedAt: Date | null;
}

const shownLink = {
  itemId: orderItems.id,
  idx: orderItems.idx,
  link: orderItems.activationLink,
  activatedAt: orderItems.activatedAt,
};
const toShown = (r: { itemId: string; idx: number; link: string | null; activatedAt: Date | null }): ShownLink => ({
  itemId: r.itemId,
  number: r.idx + 1,
  link: r.link as string,
  activatedAt: r.activatedAt,
});

/** Every link of the order the buyer has received, closed ones included. */
export async function deliveredLinks(db: Db, orderId: string): Promise<ShownLink[]> {
  const rows = await db
    .select(shownLink)
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), isNotNull(orderItems.deliveredAt), isNotNull(orderItems.activationLink)))
    .orderBy(orderItems.idx);
  return rows.map(toShown);
}

/** The links one buyer chat message shows. */
export async function linksInMessage(db: Db, orderId: string, messageId: number): Promise<ShownLink[]> {
  const rows = await db
    .select(shownLink)
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, orderId),
        isNotNull(orderItems.activationLink),
        sql`${orderItems.messageIds} @> array[${messageId}::integer]`,
      ),
    )
    .orderBy(orderItems.idx);
  return rows.map(toShown);
}

/** Telegram accepted a buyer message carrying these links: they are delivered, and shown there. */
export async function recordLinkMessage(db: Db, itemIds: string[], messageId: number): Promise<void> {
  if (itemIds.length === 0) return;
  await db
    .update(orderItems)
    .set({
      deliveredAt: sql`coalesce(${orderItems.deliveredAt}, now())`,
      messageIds: sql`array_append(${orderItems.messageIds}, ${messageId}::integer)`,
    })
    .where(inArray(orderItems.id, itemIds));
}

/** A link of this buyer's, with its order. Undefined if it is not theirs or was never delivered. */
export async function findOwnLink(
  db: Db,
  telegramId: number,
  itemId: string,
): Promise<{ item: OrderItem; order: Order } | undefined> {
  if (!UUID.test(itemId)) return undefined;
  const [row] = await db
    .select({ item: orderItems, order: orders })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orderItems.id, itemId), eq(orders.telegramId, telegramId), isNotNull(orderItems.deliveredAt)));
  return row;
}

/**
 * The buyer activated these links (all of the order's when no ids are given): they are closed for
 * good. Once as many links are activated as were ordered, the order counts as activated.
 * Returns the links closed by this call, with the messages that show them.
 */
export async function closeLinks(db: Db, orderId: string, itemIds?: string[]): Promise<{ id: string; messageIds: number[] }[]> {
  const conditions = [eq(orderItems.orderId, orderId), isNotNull(orderItems.deliveredAt), isNull(orderItems.activatedAt)];
  if (itemIds) conditions.push(inArray(orderItems.id, itemIds));
  const closed = await db
    .update(orderItems)
    .set({ activatedAt: sql`now()` })
    .where(and(...conditions))
    .returning({ id: orderItems.id, messageIds: orderItems.messageIds });
  await db
    .update(orders)
    .set({ activatedConfirmedAt: sql`now()` })
    .where(
      and(
        eq(orders.id, orderId),
        isNull(orders.activatedConfirmedAt),
        sql`(select count(*) from ${orderItems} where ${orderItems.orderId} = ${orderId} and ${orderItems.activatedAt} is not null) >= ${orders.quantity}`,
      ),
    );
  return closed;
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

export function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | undefined)?.code;
  return code(err) === '23505' || code((err as { cause?: unknown } | undefined)?.cause) === '23505';
}

// ---------------------------------------------------------------- draft carts (Prompt D section 2)

export async function getOrderDraft(db: Db, telegramId: number): Promise<OrderDraft | undefined> {
  const [draft] = await db.select().from(orderDrafts).where(eq(orderDrafts.telegramId, telegramId));
  return draft;
}

export async function saveOrderDraft(
  db: Db,
  { telegramId, quantity, messageId }: { telegramId: number; quantity: number; messageId?: number },
): Promise<OrderDraft> {
  const [draft] = await db
    .insert(orderDrafts)
    .values({
      telegramId,
      quantity,
      messageId,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: orderDrafts.telegramId,
      set: {
        quantity,
        ...(messageId !== undefined && { messageId }),
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return draft!;
}

export async function deleteOrderDraft(db: Db, telegramId: number): Promise<void> {
  await db.delete(orderDrafts).where(eq(orderDrafts.telegramId, telegramId));
}

/** Draft rows older than 24 hours are deleted by the reconciler (Prompt D section 2). */
export async function deleteOldOrderDrafts(db: Db, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(orderDrafts)
    .where(sql`${orderDrafts.updatedAt} < ${olderThan.toISOString()}::timestamptz`)
    .returning({ telegramId: orderDrafts.telegramId });
  return deleted.length;
}

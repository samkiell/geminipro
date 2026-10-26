import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { orders, type Order, type OrderStatus } from '../db/schema.js';

// Every state change is a conditional UPDATE: it only applies if the order is still in an
// expected state, so concurrent webhooks, retries and the reconciler cannot double-apply it.

/** Orders a payment can still settle. Late payments after expiry are honoured: the money moved. */
export const PAYABLE: readonly OrderStatus[] = ['awaiting_payment', 'expired'];

export function paymentReference(orderId: string): string {
  return `gp_${orderId}`;
}

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

/** awaiting_payment | expired -> paid. Returns the order only if this call made the change. */
export async function markPaid(db: Db, orderId: string): Promise<Order | undefined> {
  const [order] = await db
    .update(orders)
    .set({ status: 'paid', paidAt: sql`now()`, error: null })
    .where(and(eq(orders.id, orderId), inArray(orders.status, PAYABLE)))
    .returning();
  return order;
}

/** awaiting_payment | expired -> needs_attention, for a payment that did not match the order. */
export async function holdPayment(db: Db, orderId: string, reason: string): Promise<Order | undefined> {
  const [order] = await db
    .update(orders)
    .set({ status: 'needs_attention', error: reason })
    .where(and(eq(orders.id, orderId), inArray(orders.status, PAYABLE)))
    .returning();
  return order;
}

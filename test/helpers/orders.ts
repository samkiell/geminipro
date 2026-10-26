import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { orderItems, orders, users, type OrderStatus } from '../../src/db/schema.js';
import { paymentReference } from '../../src/services/orders.js';

export async function insertOrder(
  db: Db,
  {
    status = 'paid',
    quantity = 1,
    telegramId = 42,
    paid = ['paid', 'fulfilling', 'partial', 'delivered'].includes(status),
    expiresAt,
    leaseUntil,
  }: {
    status?: OrderStatus;
    quantity?: number;
    telegramId?: number;
    paid?: boolean;
    expiresAt?: Date;
    leaseUntil?: Date;
  } = {},
) {
  const id = randomUUID();
  await db.insert(users).values({ telegramId }).onConflictDoNothing();
  await db.insert(orders).values({
    id,
    telegramId,
    quantity,
    unitPriceNgn: 3500,
    amountNgn: 3500 * quantity,
    status,
    paymentReference: paymentReference(id),
    checkoutId: `chk_${id.slice(0, 8)}`,
    paidAt: paid ? new Date() : null,
    expiresAt: expiresAt ?? new Date(Date.now() + 15 * 60_000),
    fulfilLeaseUntil: leaseUntil ?? null,
  });
  return id;
}

export async function getOrder(db: Db, id: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) throw new Error(`order ${id} not found`);
  return order;
}

export function getItems(db: Db, orderId: string) {
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.idx));
}

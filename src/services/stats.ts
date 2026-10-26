import { and, count, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { orders } from '../db/schema.js';

// Numbers for /stats and the daily summary. "Today" is the calendar day in WAT (UTC+1, no DST).

const WAT_OFFSET_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Midnight WAT at the start of the day `now` falls in. */
export function startOfWatDay(now: Date): Date {
  return new Date(Math.floor((now.getTime() + WAT_OFFSET_MS) / DAY_MS) * DAY_MS - WAT_OFFSET_MS);
}

/** "2026-10-26": the WAT calendar date. */
export function watDateKey(now: Date): string {
  return new Date(now.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

export interface Totals {
  orders: number;
  links: number;
  revenueNgn: number;
}

export interface SalesStats {
  today: Totals;
  total: Totals;
  /** Paid orders not (fully) delivered: partial or needs attention. */
  failures: number;
  /** Paid and still being bought. */
  inProgress: number;
  /** Unpaid orders still inside their payment window. */
  pending: number;
}

async function totals(db: Db, since?: Date): Promise<Totals> {
  const conditions = [isNotNull(orders.paidAt), sql`${orders.status} <> 'refunded'`];
  if (since) conditions.push(gte(orders.paidAt, since));
  const [row] = await db
    .select({
      orders: sql<number>`count(*)::int`,
      links: sql<number>`coalesce(sum(${orders.quantity}), 0)::int`,
      revenueNgn: sql<number>`coalesce(sum(${orders.amountNgn}), 0)::int`,
    })
    .from(orders)
    .where(and(...conditions));
  return { orders: row?.orders ?? 0, links: row?.links ?? 0, revenueNgn: row?.revenueNgn ?? 0 };
}

export async function salesStats(db: Db, now = new Date()): Promise<SalesStats> {
  const [today, total, failures, inProgress, pending] = await Promise.all([
    totals(db, startOfWatDay(now)),
    totals(db),
    db
      .select({ n: count() })
      .from(orders)
      .where(and(isNotNull(orders.paidAt), inArray(orders.status, ['partial', 'needs_attention']))),
    db
      .select({ n: count() })
      .from(orders)
      .where(inArray(orders.status, ['paid', 'fulfilling'])),
    db
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.status, 'awaiting_payment'), sql`${orders.expiresAt} > now()`)),
  ]);
  return {
    today,
    total,
    failures: failures[0]?.n ?? 0,
    inProgress: inProgress[0]?.n ?? 0,
    pending: pending[0]?.n ?? 0,
  };
}

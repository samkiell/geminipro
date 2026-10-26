import { and, count, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { escapeHtml } from '../bot/telegram.js';
import { naira } from '../bot/views.js';
import { orderItems, orders } from '../db/schema.js';
import type { ReferralStats } from './referrals.js';

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
  /** Links buyers marked activated (and so closed), against links delivered. */
  activation: { delivered: number; activated: number; activatedToday: number };
}

async function totals(db: Db, since?: Date): Promise<Totals> {
  // Sales only: free referral links are reported on their own line.
  const conditions = [isNotNull(orders.paidAt), sql`${orders.status} <> 'refunded'`, eq(orders.source, 'purchase')];
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

async function activation(db: Db, now: Date): Promise<SalesStats['activation']> {
  const [row] = await db
    .select({
      delivered: sql<number>`count(${orderItems.deliveredAt})::int`,
      activated: sql<number>`count(${orderItems.activatedAt})::int`,
      activatedToday: sql<number>`(count(*) filter (where ${orderItems.activatedAt} >= ${startOfWatDay(now).toISOString()}::timestamptz))::int`,
    })
    .from(orderItems);
  return { delivered: row?.delivered ?? 0, activated: row?.activated ?? 0, activatedToday: row?.activatedToday ?? 0 };
}

/** A titled section of /stats and the daily summary. */
export interface StatsBlock {
  title: string;
  lines: string[];
}

const howMany = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const totalsLine = (t: Totals) => `${howMany(t.orders, 'order', 'orders')} · ${howMany(t.links, 'link', 'links')} · ${naira(t.revenueNgn)}`;

/** Sales, orders open right now, activations and referrals: one block each. */
export function statsBlocks(s: SalesStats, r: ReferralStats, linkPriceCents?: number): StatsBlock[] {
  const a = s.activation;
  const rate = a.delivered > 0 ? ` (${Math.round((a.activated / a.delivered) * 100)}%)` : '';
  const cost = linkPriceCents !== undefined ? ` ($${((r.rewardLinks * linkPriceCents) / 100).toFixed(2)})` : '';
  return [
    { title: '💰 sales', lines: [`today: ${totalsLine(s.today)}`, `all time: ${totalsLine(s.total)}`] },
    { title: '⏳ right now', lines: [`in progress: ${s.inProgress}`, `waiting for payment: ${s.pending}`, `failures: ${s.failures}`] },
    { title: '✅ activations', lines: [`${a.activated} of ${a.delivered} delivered links${rate}`, `today: ${a.activatedToday}`] },
    {
      title: '🎁 referrals',
      lines: [`friends who bought: ${r.qualified}`, `free links granted: ${r.rewardsGranted}`, `cost: ${howMany(r.rewardLinks, 'link', 'links')}${cost}`],
    },
  ];
}

/** Telegram HTML: each block is a bold title over a quote, so the sections stand apart. */
export function blocksHtml(blocks: StatsBlock[]): string {
  return blocks.map((b) => `<b>${escapeHtml(b.title)}</b>\n<blockquote>${b.lines.map(escapeHtml).join('\n')}</blockquote>`).join('\n');
}

/** Plain text for alerts, which also go to email and ntfy: title, lines, a blank line between. */
export function blocksText(blocks: StatsBlock[]): string {
  return blocks.map((b) => [b.title, ...b.lines].join('\n')).join('\n\n');
}

/** Paid sales since a moment (the previous summary). */
export function salesSince(db: Db, since: Date): Promise<Totals> {
  return totals(db, since);
}

export async function salesStats(db: Db, now = new Date()): Promise<SalesStats> {
  const [today, total, failures, inProgress, pending, activated] = await Promise.all([
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
    activation(db, now),
  ]);
  return {
    today,
    total,
    failures: failures[0]?.n ?? 0,
    inProgress: inProgress[0]?.n ?? 0,
    pending: pending[0]?.n ?? 0,
    activation: activated,
  };
}

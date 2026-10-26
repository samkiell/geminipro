import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Flows } from '../bot/flows.js';
import { readUsage } from '../agent/usage.js';
import type { Db } from '../db/client.js';
import { events, orders } from '../db/schema.js';
import type { Logger } from '../util/logger.js';
import type { Notify } from './notifier.js';
import { deleteOldOrderDrafts, expireUnpaidOrders, holdPayment, markPaid, reservedUnits } from './orders.js';
import { paymentProblem, type PaymentProvider } from './payments.js';
import type { ResellerClient } from './reseller.js';
import { getSetting, setSetting } from './settings.js';
import { referralStats } from './referrals.js';
import { blocksText, salesStats, statsBlocks, watDateKey } from './stats.js';

// docs/ARCHITECTURE.md 7.4. Catches whatever the event driven paths missed: a sleeping service,
// a lost webhook, a crash in the middle of fulfilment. Runs once at boot, then on timers.

export interface ReconcilerDeps {
  db: Db;
  logger: Logger;
  notify: Notify;
  flows: Pick<Flows, 'orderChanged'>;
  fulfil: (orderId: string) => Promise<unknown>;
  payments: Pick<PaymentProvider, 'verifyPayment'>;
  reseller: Pick<ResellerClient, 'getBalance' | 'getProduct'>;
  productId: number;
  lowBalanceLinks: number;
  sendNudges: () => Promise<number>;
  sendReminders: () => Promise<number>;
  /** Referral rewards held back earlier (paused, no stock). */
  grantRewards?: () => Promise<number>;
  /** Checked before every run; false skips it (a local run on the live shop's database stands down). */
  active?: () => Promise<boolean>;
  ordersEveryMs?: number;
  balanceEveryMs?: number;
  now?: () => Date;
}

const VERIFY_EVERY_MS = 2 * 60_000;
const NEEDS_ATTENTION_RETRY_MINUTES = 10;
const DAILY_SUMMARY_HOUR_WAT = 21;

export function createReconciler(deps: ReconcilerDeps) {
  const { db, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const lastVerified = new Map<string, number>();
  const timers: NodeJS.Timeout[] = [];
  const running = { orders: false, balance: false };

  /** One job's failure must never stop the others. */
  async function step(name: string, job: () => Promise<unknown>): Promise<void> {
    try {
      await job();
    } catch (err) {
      logger.error({ err, step: name }, 'reconciler step failed');
    }
  }

  async function expire(): Promise<void> {
    for (const order of await expireUnpaidOrders(db)) deps.flows.orderChanged(order.id);
  }

  /** Unpaid or expired orders up to a day old: ask Bachs whether they were paid after all. */
  async function verifyStale(): Promise<void> {
    const candidates = await db
      .select()
      .from(orders)
      .where(
        and(
          inArray(orders.status, ['awaiting_payment', 'expired']),
          isNotNull(orders.checkoutId),
          sql`${orders.createdAt} > now() - interval '24 hours'`,
          sql`${orders.createdAt} < now() - interval '2 minutes'`,
        ),
      )
      .limit(25);
    const t = now().getTime();
    const deliveries: Promise<unknown>[] = [];
    for (const order of candidates) {
      if (t - (lastVerified.get(order.id) ?? 0) < VERIFY_EVERY_MS) continue;
      lastVerified.set(order.id, t);
      let checkout;
      try {
        checkout = await deps.payments.verifyPayment(order.checkoutId as string);
      } catch (err) {
        logger.warn({ orderId: order.id, err: (err as Error).message }, 'could not check a stale checkout');
        continue;
      }
      if (checkout.status !== 'completed') continue;
      const problem = paymentProblem(order, checkout);
      if (problem) {
        if (await holdPayment(db, order.id, problem)) {
          deps.flows.orderChanged(order.id);
          deps.notify({ level: 'critical', title: 'payment held for review', body: `Order ${order.orderNo} was not marked paid: ${problem}.` });
        }
        continue;
      }
      const paid = await markPaid(db, order.id);
      if (!paid) continue;
      await db.insert(events).values({ kind: 'reconciler_paid', ref: order.id, payload: { checkoutId: order.checkoutId } });
      logger.warn({ orderId: order.id, orderNo: order.orderNo }, 'missed payment webhook caught by the reconciler');
      deps.flows.orderChanged(order.id);
      deliveries.push(deps.fulfil(order.id));
    }
    if (lastVerified.size > 5_000) lastVerified.clear();
    // Like recover(): the run is not over until these are delivered, so ticks never overlap them.
    await Promise.allSettled(deliveries);
  }

  /** Paid orders that are not delivered: never started, half done, or abandoned by a crash. */
  async function recover(): Promise<void> {
    const stuck = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          isNotNull(orders.paidAt),
          or(
            inArray(orders.status, ['paid', 'partial']),
            and(eq(orders.status, 'fulfilling'), lt(orders.fulfilLeaseUntil, sql`now()`)),
            // Nothing could be bought last time (balance, stock): try again now and then.
            and(
              eq(orders.status, 'needs_attention'),
              sql`${orders.updatedAt} < now() - make_interval(mins => ${NEEDS_ATTENTION_RETRY_MINUTES})`,
              sql`coalesce(${orders.error}, '') not like 'delivery blocked%'`,
            ),
          ),
        ),
      )
      .limit(20);
    await Promise.all(stuck.map((o) => deps.fulfil(o.id)));
  }

  async function dailySummary(): Promise<void> {
    const t = now();
    const hourWat = (t.getUTCHours() + 1) % 24;
    if (hourWat < DAILY_SUMMARY_HOUR_WAT) return;
    const today = watDateKey(t);
    if ((await getSetting<string>(db, 'last_daily_summary')) === today) return;
    await setSetting(db, 'last_daily_summary', today);

    const [s, ai, refs] = await Promise.all([salesStats(db, t), readUsage(db, t), referralStats(db)]);
    let reseller = ['unreachable'];
    let linkPriceCents: number | undefined;
    try {
      const [balance, product] = await Promise.all([deps.reseller.getBalance(), deps.reseller.getProduct(deps.productId)]);
      const covers = product.priceCents > 0 ? Math.floor(balance.balanceCents / product.priceCents) : 0;
      linkPriceCents = product.priceCents;
      reseller = [`balance: $${(balance.balanceCents / 100).toFixed(2)}`, `covers: ${covers} links`, `stock: ${product.stock}`];
    } catch {
      // keep the placeholder
    }
    const blocks = statsBlocks(s, refs, linkPriceCents);
    blocks.splice(2, 0, { title: '📦 reseller', lines: reseller });
    blocks.push({
      title: '🤖 ai today',
      lines: [`model calls: ${ai.calls} (${ai.rateLimited} rate limited)`, `answered free: ${ai.free}`, `scripted fallbacks: ${ai.fallbacks}`],
    });
    deps.notify({ level: 'info', title: 'daily summary', body: blocksText(blocks) });
  }

  /** True when this process must not touch orders. A failed check never stops the live shop. */
  async function standDown(): Promise<boolean> {
    if (!deps.active) return false;
    try {
      return !(await deps.active());
    } catch {
      return false;
    }
  }

  async function runOrders(): Promise<void> {
    if (running.orders) return;
    running.orders = true;
    try {
      if (await standDown()) return;
      await step('expire', expire);
      await step('clean old drafts', async () => deleteOldOrderDrafts(db, new Date(now().getTime() - 24 * 60 * 60_000)));
      await step('nudges', deps.sendNudges);
      await step('verify stale checkouts', verifyStale);
      await step('recover fulfilment', recover);
      if (deps.grantRewards) await step('referral rewards', deps.grantRewards);
      await step('activation reminders', deps.sendReminders);
      await step('daily summary', dailySummary);
    } finally {
      running.orders = false;
    }
  }

  /** Low balance or stock: fewer links left to sell than LOW_BALANCE_ORDERS. */
  async function runBalance(): Promise<void> {
    if (running.balance) return;
    running.balance = true;
    try {
      if (await standDown()) return;
      await step('balance check', async () => {
        const [balance, product, reserved] = await Promise.all([
          deps.reseller.getBalance(),
          deps.reseller.getProduct(deps.productId),
          reservedUnits(db),
        ]);
        const byBalance = product.priceCents > 0 ? Math.floor(balance.balanceCents / product.priceCents) - reserved : 0;
        const byStock = (product.inStock ? product.stock : 0) - reserved;
        if (byStock < deps.lowBalanceLinks && byStock <= byBalance) {
          deps.notify({
            level: byStock <= 0 ? 'critical' : 'warning',
            title: byStock <= 0 ? 'out of stock' : 'low stock',
            body: `The reseller has ${product.stock} links left (${reserved} promised to open orders).`,
            cooldownKey: 'low_stock',
          });
        } else if (byBalance < deps.lowBalanceLinks) {
          deps.notify({
            level: byBalance <= 0 ? 'critical' : 'warning',
            title: 'low reseller balance',
            body: `Balance $${(balance.balanceCents / 100).toFixed(2)} covers ${Math.max(0, byBalance)} more links (${reserved} promised to open orders). Top up the reseller.`,
            cooldownKey: 'low_balance',
          });
        }
      });
    } finally {
      running.balance = false;
    }
  }

  return {
    runOrders,
    runBalance,
    /** Runs both once now, then on their timers. */
    start(): void {
      void runOrders();
      void runBalance();
      timers.push(setInterval(() => void runOrders(), deps.ordersEveryMs ?? 30_000));
      timers.push(setInterval(() => void runBalance(), deps.balanceEveryMs ?? 5 * 60_000));
    },
    stop(): void {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  };
}

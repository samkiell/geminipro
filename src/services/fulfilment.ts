import { setTimeout as sleep } from 'node:timers/promises';
import { asc, eq, sql } from 'drizzle-orm';
import { SendError, type TelegramPort } from '../bot/telegram.js';
import { delayedMessage, linksMessages, type UiFacts } from '../bot/views.js';
import type { Db } from '../db/client.js';
import { events, orderItems, orders, users, type Order, type OrderItem } from '../db/schema.js';
import type { Logger } from '../util/logger.js';
import { Semaphore } from '../util/semaphore.js';
import type { Notify } from './notifier.js';
import { claimForFulfilment, finishFulfilment, recordLinkMessage, renewLease } from './orders.js';
import { ResellerError, type ResellerClient } from './reseller.js';
import { setPaused } from './settings.js';

// docs/ARCHITECTURE.md 7.3. Each link is its own reseller purchase with a fixed idempotency key
// (`${orderId}-${idx}`), so any number of runs, crashes and retries buy each link at most once.

export interface FulfilmentDeps {
  db: Db;
  reseller: Pick<ResellerClient, 'createOrder'>;
  productId: number;
  port: TelegramPort;
  facts: UiFacts;
  notify: Notify;
  logger: Logger;
  /** Called after every status change, to keep the buyer's status message live. */
  onChange?: (orderId: string) => void;
  /** Waits between tries of one link after out_of_stock, insufficient_funds or a supplier failure. */
  itemRetryDelaysMs?: number[];
}

export type FulfilOutcome = 'not_claimed' | 'delivered' | 'partial' | 'needs_attention' | 'delivery_failed';

// Definite "no" from the reseller that may clear up shortly. Unknown outcomes (timeouts, 5xx) are
// already retried inside the reseller client and are left for the next run, with the same key.
const RETRY_LATER = new Set(['out_of_stock', 'insufficient_funds', 'supplier_purchase_failed', 'transaction_error']);
const AUTH_FAILED = new Set(['invalid_api_key', 'missing_api_key']);

export function itemIdempotencyKey(orderId: string, idx: number): string {
  return `${orderId}-${idx}`;
}

/** At most `concurrency` orders are bought at once, so a rush of payments cannot flood the reseller. */
export function createFulfilment(deps: FulfilmentDeps, concurrency = 3) {
  const slots = new Semaphore(concurrency);
  return { fulfil: (orderId: string) => slots.run(() => fulfil(deps, orderId)) };
}

export async function fulfil(deps: FulfilmentDeps, orderId: string): Promise<FulfilOutcome> {
  const { db } = deps;
  const [before] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  const order = await claimForFulfilment(db, orderId);
  if (!order) return 'not_claimed';
  deps.onChange?.(orderId);

  const log = deps.logger.child({ orderId, orderNo: order.orderNo });
  log.info({ quantity: order.quantity, from: before?.status }, 'fulfilment started');
  await ensureItems(db, order);

  const failures: string[] = [];
  for (const item of await loadItems(db, orderId)) {
    if (item.status === 'completed' || item.idx >= order.quantity) continue;
    await renewLease(db, orderId);
    const result = await buyItem(deps, item, log);
    if (result !== 'completed') failures.push(`link ${item.idx + 1}: ${result}`);
    if (AUTH_FAILED.has(result)) break;
  }

  // Replacement links (/replace) sit beyond the ordered quantity and are delivered by admin.
  const items = (await loadItems(db, orderId)).filter((i) => i.idx < order.quantity);
  const bought = items.filter((i) => i.status === 'completed' && i.activationLink);
  const fresh = bought.filter((i) => !i.deliveredAt);
  const remaining = order.quantity - bought.length;
  const deliveredBefore = bought.length - fresh.length;

  if (fresh.length > 0) {
    const parts = linksMessages({
      orderNo: order.orderNo,
      quantity: order.quantity,
      links: fresh.map((i) => ({ number: i.idx + 1, link: i.activationLink as string, itemId: i.id })),
      mode: deliveredBefore === 0 ? 'first' : 'more',
      remaining,
      facts: deps.facts,
    });
    for (const part of parts) {
      let messageId: number;
      try {
        messageId = await deps.port.send(order.telegramId, part);
      } catch (err) {
        return finish(deps, deliveryFailed(deps, order, err, deliveredBefore > 0, log), orderId);
      }
      // Delivered only once Telegram accepted the message that carries the link.
      await recordLinkMessage(db, part.itemIds, messageId);
    }
    log.info({ links: fresh.length }, 'links delivered');
  }

  if (remaining === 0) {
    await finishFulfilment(db, orderId, 'delivered', null);
    log.info('order delivered');
    return finish(deps, Promise.resolve('delivered'), orderId);
  }

  const reason = failures.join('; ') || 'links not bought yet';
  if (bought.length > 0) {
    await finishFulfilment(db, orderId, 'partial', reason);
    deps.notify({
      level: 'warning',
      title: 'partial order',
      body: `Order ${order.orderNo}: ${bought.length} of ${order.quantity} links delivered. ${reason}. It will be retried.`,
    });
    return finish(deps, Promise.resolve('partial'), orderId);
  }

  await finishFulfilment(db, orderId, 'needs_attention', reason);
  deps.notify({
    level: 'critical',
    title: 'paid order not fulfilled',
    body: `Order ${order.orderNo} (${order.quantity} links) is paid but no link could be bought. ${reason}.`,
  });
  if (before?.status === 'paid') {
    // First attempt only, so retries do not spam the buyer.
    await deps.port
      .send(order.telegramId, delayedMessage(order, deps.facts))
      .catch((err: unknown) => log.warn({ err: describe(err) }, 'could not tell the buyer about the delay'));
  }
  return finish(deps, Promise.resolve('needs_attention'), orderId);
}

async function finish(deps: FulfilmentDeps, outcome: Promise<FulfilOutcome>, orderId?: string): Promise<FulfilOutcome> {
  const result = await outcome;
  if (orderId) deps.onChange?.(orderId);
  return result;
}

async function ensureItems(db: Db, order: Order): Promise<void> {
  const rows = Array.from({ length: order.quantity }, (_, idx) => ({
    orderId: order.id,
    idx,
    idempotencyKey: itemIdempotencyKey(order.id, idx),
  }));
  await db.insert(orderItems).values(rows).onConflictDoNothing();
}

function loadItems(db: Db, orderId: string): Promise<OrderItem[]> {
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.idx));
}

/** Buys one link. Returns 'completed' or the reason it is still missing. */
async function buyItem(deps: FulfilmentDeps, item: OrderItem, log: Logger): Promise<string> {
  const { db } = deps;
  const delays = deps.itemRetryDelaysMs ?? [2_000, 5_000];

  for (let attempt = 0; ; attempt++) {
    await db
      .update(orderItems)
      .set({ attempts: sql`${orderItems.attempts} + 1` })
      .where(eq(orderItems.id, item.id));
    try {
      const bought = await deps.reseller.createOrder(deps.productId, item.idempotencyKey);
      await db
        .update(orderItems)
        .set({ status: 'completed', activationLink: bought.value, resellerOrderCode: bought.orderCode, error: null })
        .where(eq(orderItems.id, item.id));
      // Audit trail of reseller purchases. Never the link itself.
      await db.insert(events).values({
        kind: 'reseller_order',
        ref: item.idempotencyKey,
        payload: { orderId: item.orderId, idx: item.idx, orderCode: bought.orderCode },
      });
      log.info({ idx: item.idx, orderCode: bought.orderCode }, 'link bought');
      return 'completed';
    } catch (err) {
      const code = err instanceof ResellerError ? err.code : 'unexpected_error';
      if (RETRY_LATER.has(code) && attempt < delays.length) {
        log.warn({ idx: item.idx, code, attempt: attempt + 1 }, 'link purchase refused, trying again');
        await sleep(delays[attempt] ?? 0);
        continue;
      }
      // The key stays, so the next run asks the reseller about the same purchase, never a new one.
      await db.update(orderItems).set({ status: 'failed', error: code }).where(eq(orderItems.id, item.id));
      log.warn({ idx: item.idx, code, err: describe(err) }, 'link not bought');

      if (AUTH_FAILED.has(code)) {
        await setPaused(db, true);
        deps.notify({
          level: 'critical',
          title: 'reseller api key rejected',
          body: `The reseller returned ${code}. Sales are paused until the key is fixed and /resume is sent.`,
          cooldownKey: 'reseller_key',
        });
      }
      return code;
    }
  }
}

async function deliveryFailed(
  deps: FulfilmentDeps,
  order: Order,
  err: unknown,
  someDeliveredBefore: boolean,
  log: Logger,
): Promise<FulfilOutcome> {
  const { db } = deps;
  if (err instanceof SendError && err.kind === 'blocked') {
    await db.update(users).set({ blocked: true }).where(eq(users.telegramId, order.telegramId));
    await finishFulfilment(db, order.id, 'needs_attention', `delivery blocked: ${err.message}`);
    log.warn({ err: err.message }, 'buyer blocked the bot; links kept for support');
    deps.notify({
      level: 'critical',
      title: 'could not deliver links',
      body: `Order ${order.orderNo}: Telegram refused delivery (${err.message}). The links are saved; send them with /resend.`,
    });
    return 'needs_attention';
  }
  // Transient: hand the order back so the next run sends the undelivered links again.
  await finishFulfilment(db, order.id, someDeliveredBefore ? 'partial' : 'paid', `delivery failed: ${describe(err)}`);
  log.warn({ err: describe(err) }, 'link delivery failed, will retry');
  return 'delivery_failed';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

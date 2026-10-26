import { and, asc, count, desc, eq, getTableColumns, isNotNull, like, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, orderItems, orders, type Order, type OrderStatus } from '../db/schema.js';
import type { BachsClient } from '../services/bachs.js';
import { resendMessage, type SendMessage } from '../services/delivery.js';
import type { Notify } from '../services/notifier.js';
import { cancelPendingOrder, createOrder, PAYMENT_WINDOW_MINUTES, reservedUnits } from '../services/orders.js';
import { priceFor, type PricingConfig } from '../services/pricing.js';
import type { ResellerClient } from '../services/reseller.js';
import { isPaused } from '../services/settings.js';
import type { Logger } from '../util/logger.js';
import { CHECKOUT_FEE_NOTE, type BuyerServices, type PaymentLinkResult } from './tools.js';

export const MAX_RESENDS_PER_ORDER = 3;

const MEANING: Record<OrderStatus, string> = {
  created: 'payment link being created',
  awaiting_payment: 'waiting for payment',
  paid: 'paid, links being prepared',
  fulfilling: 'paid, links being prepared',
  partial: 'some links sent, the rest on the way',
  delivered: 'delivered',
  expired: 'payment link expired, not paid',
  needs_attention: 'being handled by support',
  refunded: 'refunded',
  cancelled: 'cancelled',
};

export interface BuyerServicesDeps {
  db: Db;
  reseller: Pick<ResellerClient, 'getAvailability'>;
  bachs: Pick<BachsClient, 'createCheckout'>;
  pricing: PricingConfig;
  maxQtyPerOrder: number;
  salesCutoff: Date | undefined;
  returnUrl: string | undefined;
  supportWhatsapp: string;
  send: SendMessage;
  notify: Notify;
  logger: Logger;
}

export function createBuyerServices(deps: BuyerServicesDeps): BuyerServices {
  const { db } = deps;
  // Without gross up, Bachs (customer_pays) adds its fee on the checkout page.
  const feeNote = deps.pricing.grossUp ? {} : { feeNote: CHECKOUT_FEE_NOTE };

  return {
    getPrice(quantity) {
      const { baseNgn, feeNgn, totalNgn } = priceFor(quantity, deps.pricing);
      return { quantity, baseNgn, feeNgn, totalNgn, ...feeNote };
    },

    async checkAvailability() {
      if (await isPaused(db)) return { canSell: false, maxQuantity: 0, reason: 'sales are paused' };
      if (deps.salesCutoff && new Date() >= deps.salesCutoff) {
        return { canSell: false, maxQuantity: 0, reason: 'sales have closed' };
      }
      try {
        return await deps.reseller.getAvailability(await reservedUnits(db));
      } catch {
        return { canSell: false, maxQuantity: 0, reason: 'stock could not be checked right now' };
      }
    },

    async createPaymentLink(telegramId, quantity): Promise<PaymentLinkResult> {
      const result = await createOrder(deps, { telegramId, quantity });
      if (result.ok) {
        return {
          ok: true,
          orderId: result.order.id,
          quantity,
          totalNgn: result.order.amountNgn,
          expiresInMinutes: PAYMENT_WINDOW_MINUTES,
          checkoutUrl: result.checkoutUrl,
          ...feeNote,
        };
      }
      switch (result.reason) {
        case 'pending_exists': {
          const { order } = result;
          const minutesLeft = order.expiresAt ? Math.max(0, Math.ceil((order.expiresAt.getTime() - Date.now()) / 60_000)) : 0;
          return {
            ok: false,
            error: 'pending_order_exists',
            orderId: order.id,
            quantity: order.quantity,
            totalNgn: order.amountNgn,
            expiresInMinutes: minutesLeft,
            checkoutUrl: order.checkoutUrl ?? undefined,
          };
        }
        case 'unavailable':
          return { ok: false, error: 'not_enough_stock', maxQuantity: result.maxQuantity };
        case 'invalid_quantity':
          return { ok: false, error: 'invalid_quantity', maxQuantity: result.maxQuantity };
        case 'paused':
          return { ok: false, error: 'sales_paused' };
        case 'closed':
          return { ok: false, error: 'sales_closed' };
        case 'checkout_failed':
          return { ok: false, error: 'payment_link_failed' };
      }
    },

    async getMyOrders(telegramId) {
      const rows = await db
        .select({
          id: orders.id,
          quantity: orders.quantity,
          status: orders.status,
          amountNgn: orders.amountNgn,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.telegramId, telegramId))
        .orderBy(desc(orders.createdAt))
        .limit(5);
      return rows.map((o) => ({
        orderRef: o.id.slice(0, 8),
        quantity: o.quantity,
        status: o.status,
        meaning: MEANING[o.status],
        totalNgn: o.amountNgn,
        createdAt: o.createdAt.toISOString(),
      }));
    },

    async resendMyLinks(telegramId, orderRef) {
      let order: Order | undefined;
      if (orderRef) {
        // A ref (or full id) only ever matches this user's own orders.
        const ref = orderRef.trim().toLowerCase();
        if (!/^[0-9a-f-]{4,36}$/.test(ref)) return { error: 'order_not_found' };
        [order] = await db
          .select()
          .from(orders)
          .where(and(eq(orders.telegramId, telegramId), like(sql`${orders.id}::text`, `${ref}%`)))
          .orderBy(desc(orders.createdAt))
          .limit(1);
        if (!order) return { error: 'order_not_found' };
      } else {
        [order] = await db
          .select(getTableColumns(orders))
          .from(orders)
          .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
          .where(and(eq(orders.telegramId, telegramId), isNotNull(orderItems.deliveredAt)))
          .orderBy(desc(orders.createdAt))
          .limit(1);
        if (!order) return { error: 'no_delivered_links' };
      }
      const orderId = order.id;

      const links = await db
        .select({ idx: orderItems.idx, link: orderItems.activationLink })
        .from(orderItems)
        .where(and(eq(orderItems.orderId, orderId), isNotNull(orderItems.deliveredAt), isNotNull(orderItems.activationLink)))
        .orderBy(asc(orderItems.idx));
      if (links.length === 0) return { error: 'no_delivered_links', status: order.status };

      const [resends] = await db
        .select({ n: count() })
        .from(events)
        .where(and(eq(events.kind, 'link_resend'), eq(events.ref, orderId)));
      if ((resends?.n ?? 0) >= MAX_RESENDS_PER_ORDER) return { error: 'resend_limit_reached' };

      const text = resendMessage({
        links: links.map((l) => ({ number: l.idx + 1, link: l.link as string })),
        quantity: order.quantity,
        supportWhatsapp: deps.supportWhatsapp,
      });
      try {
        await deps.send(telegramId, text);
      } catch (err) {
        deps.logger.warn({ orderId, err: (err as Error).message }, 'resend failed');
        return { error: 'send_failed' };
      }
      await db.insert(events).values({ kind: 'link_resend', ref: orderId, payload: { links: links.length } });
      return { sent: links.length };
    },

    async cancelPendingOrder(telegramId) {
      return { cancelled: (await cancelPendingOrder(db, telegramId)) !== undefined };
    },

    async escalate(telegramId, reason) {
      deps.notify({
        level: 'warning',
        title: 'buyer needs support',
        body: `Telegram user ${telegramId}: ${reason}`,
      });
      return { supportWhatsapp: deps.supportWhatsapp };
    },
  };
}

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { HelpPage } from '../content/help.js';
import type { Db } from '../db/client.js';
import { orders, type Order } from '../db/schema.js';
import type { Notify } from '../services/notifier.js';
import {
  cancelOwnOrder,
  cancelPendingOrder,
  closeLinks,
  createOrder,
  deliveredLinks,
  expireUnpaidOrders,
  findOwnLink,
  findOwnOrder,
  findOwnOrderByNo,
  findPendingOrder,
  historyPage,
  linksInMessage,
  PAYMENT_WINDOW_MINUTES,
  recordLinkMessage,
  reservedUnits,
  setOrderMessages,
  UNPAID_OPEN,
  type CreateOrderDeps,
  type CreateOrderResult,
} from '../services/orders.js';
import type { PaymentProvider } from '../services/payments.js';
import type { PricingConfig } from '../services/pricing.js';
import type { ResellerClient } from '../services/reseller.js';
import { getOfferText } from '../services/settings.js';
import type { Logger } from '../util/logger.js';
import type { OutMessage, TelegramPort } from './telegram.js';
import {
  activatedReply,
  activationConfirm,
  activationHelpReply,
  cb,
  helpHub,
  helpView,
  historyList,
  linkLabel,
  linksMessages,
  orderCard,
  renderStatus,
  startMessage,
  summaryCard,
  summaryResolved,
  supportButton,
  type SummaryOutcome,
  type UiFacts,
} from './views.js';

// Everything the buyer sees about an order goes through here, whether it started from a command,
// a button, the agent or the scripted fallback. In private chats the chat id is the user id.

export interface FlowDeps {
  db: Db;
  port: TelegramPort;
  logger: Logger;
  reseller: Pick<ResellerClient, 'getAvailability'>;
  payments: Pick<PaymentProvider, 'createCheckout'>;
  pricing: PricingConfig;
  facts: UiFacts;
  salesCutoff: Date | undefined;
  /** Where the buyer lands after paying: the bot's t.me link. */
  returnUrl: string | undefined;
  notify: Notify;
  /** Minimum gap between two edits of one status message. Default 1.2s. */
  statusThrottleMs?: number;
  /** Per buyer, "show my links". Default 5 a minute. */
  linksRateLimit?: { max: number; windowMs: number };
}

export type BuyOutcome =
  | { ok: true; orderNo: string; quantity: number; totalNgn: number; maxQuantity: number }
  | { ok: false; reason: 'unavailable'; maxQuantity: number }
  | { ok: false; reason: 'paused' | 'closed' | 'checkout_failed' | 'stale' };

export type Flows = ReturnType<typeof createFlows>;

export function createFlows(deps: FlowDeps) {
  const { db, port, facts, logger } = deps;
  const throttleMs = deps.statusThrottleMs ?? 1_200;
  const orderDeps = (): CreateOrderDeps => ({
    db,
    reseller: deps.reseller,
    payments: deps.payments,
    pricing: deps.pricing,
    maxQtyPerOrder: facts.maxQtyPerOrder,
    salesCutoff: deps.salesCutoff,
    returnUrl: deps.returnUrl,
  });

  // ------------------------------------------------------------ status sync (throttled, coalesced)

  const lastSync = new Map<string, number>();
  const queued = new Set<string>();
  const inFlight = new Set<Promise<void>>();

  function track(promise: Promise<void>): void {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  }

  /** Call after any change to an order: refreshes its status message and retires its card. */
  function orderChanged(orderId: string): void {
    if (queued.has(orderId)) return; // the queued sync reads the latest state when it runs
    queued.add(orderId);
    const wait = Math.max(0, (lastSync.get(orderId) ?? 0) + throttleMs - Date.now());
    const run = () => {
      queued.delete(orderId);
      lastSync.set(orderId, Date.now());
      if (lastSync.size > 5_000) lastSync.clear();
      track(sync(orderId).catch((err: unknown) => logger.warn({ orderId, err }, 'order chat sync failed')));
    };
    if (wait === 0) run();
    else setTimeout(run, wait);
  }

  /** Resolves when every queued and running chat sync has finished (for tests and shutdown). */
  async function whenIdle(): Promise<void> {
    while (queued.size > 0 || inFlight.size > 0) {
      await Promise.all([...inFlight]);
      if (queued.size > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function summaryOutcome(order: Order): SummaryOutcome | undefined {
    switch (order.status) {
      case 'created':
      case 'awaiting_payment':
        return undefined;
      case 'expired':
        return 'expired';
      case 'cancelled':
        return 'cancelled';
      case 'needs_attention':
        return order.paidAt ? 'paid' : 'held';
      default:
        return 'paid';
    }
  }

  async function sync(orderId: string): Promise<void> {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return;
    const chat = order.telegramId;

    // The card's job is done: collapse it to one line, once (claim first, edit second).
    const outcome = summaryOutcome(order);
    if (outcome && order.summaryMessageId) {
      const [claimed] = await db
        .update(orders)
        .set({ summaryMessageId: null, payMessageId: null })
        .where(and(eq(orders.id, orderId), eq(orders.summaryMessageId, order.summaryMessageId)))
        .returning({ id: orders.id });
      if (claimed) await port.edit(chat, order.summaryMessageId, summaryResolved(order, outcome));
    }

    const status = renderStatus(order, facts);
    if (order.statusMessageId) {
      const result = await port.edit(chat, order.statusMessageId, status);
      if (result === 'gone') await sendStatus(order, status);
    } else if (order.paidAt) {
      // Paid without a status message (say, an order replaced by the stepper and paid later).
      await sendStatus(order, status);
    }
  }

  async function sendStatus(order: Order, status: OutMessage): Promise<void> {
    try {
      const id = await port.send(order.telegramId, status);
      await setOrderMessages(db, order.id, { statusMessageId: id });
    } catch (err) {
      logger.warn({ orderId: order.id, err: (err as Error).message }, 'status message not sent');
    }
  }

  // ------------------------------------------------------------ buying

  /** The most this buyer could have in one order right now. Their own unpaid order counts as theirs. */
  async function availableFor(order?: Order): Promise<number> {
    try {
      const own = order && UNPAID_OPEN.includes(order.status) ? order.quantity : 0;
      const { maxQuantity } = await deps.reseller.getAvailability(Math.max(0, (await reservedUnits(db)) - own));
      return Math.min(maxQuantity, facts.maxQtyPerOrder);
    } catch {
      return 0;
    }
  }

  async function sendOrEdit(chat: number, message: OutMessage, editMessageId?: number): Promise<number | undefined> {
    if (editMessageId) {
      const result = await port.edit(chat, editMessageId, message);
      if (result === 'ok') return editMessageId;
    }
    return port.send(chat, message);
  }

  async function presentOrder(order: Order): Promise<number> {
    const [maxQuantity, offerText] = await Promise.all([availableFor(order), getOfferText(db)]);
    const cardId = await port.send(order.telegramId, summaryCard({ order, maxQuantity, offerText, facts }));
    const statusId = await port.send(order.telegramId, renderStatus(order, facts));
    await setOrderMessages(db, order.id, { summaryMessageId: cardId, payMessageId: cardId, statusMessageId: statusId });
    return maxQuantity;
  }

  async function refuse(chat: number, result: Exclude<CreateOrderResult, { ok: true }>, quantity: number): Promise<BuyOutcome> {
    switch (result.reason) {
      case 'unavailable':
        await port.send(
          chat,
          result.maxQuantity > 0
            ? {
                text: `i can sell up to ${result.maxQuantity} right now.`,
                keyboard: [[{ text: `buy ${result.maxQuantity}`, data: cb.buy(result.maxQuantity) }]],
              }
            : { text: "we're out of links right now. please check back soon.", keyboard: [[supportButton(facts)]] },
        );
        return { ok: false, reason: 'unavailable', maxQuantity: result.maxQuantity };
      case 'paused':
        await port.send(chat, { text: 'sales are paused for a moment. please check back shortly.' });
        return { ok: false, reason: 'paused' };
      case 'closed':
        await port.send(chat, { text: 'sales have closed. thank you for your interest!' });
        return { ok: false, reason: 'closed' };
      case 'checkout_failed':
      case 'invalid_quantity':
        await port.send(chat, {
          text: "i couldn't create the payment page just now. please try again in a minute.",
          keyboard: [[{ text: 'try again', data: cb.buy(quantity) }]],
        });
        return { ok: false, reason: 'checkout_failed' };
      case 'pending_exists':
        return { ok: false, reason: 'stale' };
    }
  }

  const okOutcome = (order: Order, maxQuantity: number): BuyOutcome => ({
    ok: true,
    orderNo: order.orderNo,
    quantity: order.quantity,
    totalNgn: order.amountNgn,
    maxQuantity,
  });

  /** /buy, the buy buttons, the agent and the scripted fallback all start here. */
  async function startBuy(telegramId: number, requested: number): Promise<BuyOutcome> {
    const quantity = Math.min(Math.max(Math.trunc(requested) || 1, 1), facts.maxQtyPerOrder);
    for (const expired of await expireUnpaidOrders(db, telegramId)) orderChanged(expired.id);

    const pending = await findPendingOrder(db, telegramId);
    if (pending) {
      if (pending.status === 'awaiting_payment' && pending.quantity === quantity) {
        return okOutcome(pending, await moveCard(pending));
      }
      return replaceOrder(pending, quantity, undefined);
    }

    const result = await createOrder(orderDeps(), { telegramId, quantity });
    if (!result.ok) return refuse(telegramId, result, quantity);
    return okOutcome(result.order, await presentOrder(result.order));
  }

  /** Shows an unpaid order's card again at the bottom of the chat, retiring the old copy. */
  async function moveCard(order: Order): Promise<number> {
    if (order.summaryMessageId) {
      await port.edit(order.telegramId, order.summaryMessageId, { text: `order summary · ${order.orderNo} (moved below)` });
    }
    const [maxQuantity, offerText] = await Promise.all([availableFor(order), getOfferText(db)]);
    const cardId = await port.send(order.telegramId, summaryCard({ order, maxQuantity, offerText, facts }));
    await setOrderMessages(db, order.id, { summaryMessageId: cardId, payMessageId: cardId });
    return maxQuantity;
  }

  /**
   * A different quantity means a different checkout: the unpaid order is cancelled and a new one
   * takes its place (a payment that still lands on the old one is honoured, like any late payment).
   * With editMessageId (the stepper) the same card and status message are edited in place.
   */
  async function replaceOrder(old: Order, requested: number, editMessageId: number | undefined): Promise<BuyOutcome> {
    const chat = old.telegramId;
    const available = await availableFor(old);
    const quantity = Math.min(requested, available);
    if (quantity < 1) return refuse(chat, { ok: false, reason: 'unavailable', maxQuantity: 0 }, requested);
    if (quantity === old.quantity && old.status === 'awaiting_payment') {
      if (editMessageId) {
        const offerText = await getOfferText(db);
        await port.edit(chat, editMessageId, summaryCard({ order: old, maxQuantity: available, offerText, facts }));
        return okOutcome(old, available);
      }
      return okOutcome(old, await moveCard(old));
    }

    const cancelled = await cancelOwnOrder(db, chat, old.id);
    if (!cancelled) return { ok: false, reason: 'stale' };
    const result = await createOrder(orderDeps(), { telegramId: chat, quantity });
    if (!result.ok) {
      orderChanged(cancelled.id);
      return refuse(chat, result, quantity);
    }
    const order = result.order;

    if (editMessageId && old.summaryMessageId === editMessageId) {
      // Hand the chat messages over to the new order, then redraw them for it.
      await setOrderMessages(db, old.id, { summaryMessageId: null, payMessageId: null, statusMessageId: null });
      await setOrderMessages(db, order.id, {
        summaryMessageId: old.summaryMessageId,
        payMessageId: old.payMessageId,
        statusMessageId: old.statusMessageId,
      });
      const [maxQuantity, offerText] = await Promise.all([availableFor(order), getOfferText(db)]);
      const result = await port.edit(chat, editMessageId, summaryCard({ order, maxQuantity, offerText, facts }));
      if (result !== 'ok') return okOutcome(order, await moveCard({ ...order, summaryMessageId: null }));
      if (old.statusMessageId) await port.edit(chat, old.statusMessageId, renderStatus(order, facts));
      return okOutcome(order, maxQuantity);
    }

    // From a command or the agent: retire the old messages and start fresh ones below.
    orderChanged(cancelled.id);
    return okOutcome(order, await presentOrder(order));
  }

  /** The − and + buttons. */
  async function changeQuantity(telegramId: number, messageId: number, orderId: string, target: number): Promise<BuyOutcome> {
    const order = await findOwnOrder(db, telegramId, orderId);
    if (!order || order.status !== 'awaiting_payment' || order.summaryMessageId !== messageId) {
      return { ok: false, reason: 'stale' };
    }
    return replaceOrder(order, target, messageId);
  }

  /** The card's cancel button. */
  async function cancelFromCard(telegramId: number, orderId: string): Promise<boolean> {
    const cancelled = await cancelOwnOrder(db, telegramId, orderId);
    if (cancelled) orderChanged(cancelled.id);
    return cancelled !== undefined;
  }

  /** "cancel my order" in chat. */
  async function cancelPending(telegramId: number): Promise<boolean> {
    const cancelled = await cancelPendingOrder(db, telegramId);
    if (cancelled) orderChanged(cancelled.id);
    return cancelled !== undefined;
  }

  // ------------------------------------------------------------ history, order card, links

  async function showHistory(telegramId: number, page = 1, editMessageId?: number): Promise<void> {
    let view = await historyPage(db, telegramId, page);
    if (view.orders.length === 0 && page > 1) {
      page = 1;
      view = await historyPage(db, telegramId, 1);
    }
    await sendOrEdit(telegramId, historyList({ ...view, page }), editMessageId);
  }

  async function renderOrderCard(order: Order, page: number): Promise<OutMessage> {
    const links = await deliveredLinks(db, order.id);
    const activatedLinks = links.filter((l) => l.activatedAt).length;
    return orderCard({ order, page, openLinks: links.length - activatedLinks, activatedLinks, facts });
  }

  /** From a history button: edits the history message into the order card. */
  async function showOrder(telegramId: number, orderId: string, page: number, editMessageId?: number): Promise<boolean> {
    const order = await findOwnOrder(db, telegramId, orderId);
    if (!order) return false;
    await sendOrEdit(telegramId, await renderOrderCard(order, page), editMessageId);
    return true;
  }

  /** "show order GP-1042" from the agent. */
  async function showOrderByNo(telegramId: number, orderNo: string): Promise<boolean> {
    const order = await findOwnOrderByNo(db, telegramId, orderNo);
    if (!order) return false;
    await port.send(telegramId, await renderOrderCard(order, 1));
    return true;
  }

  const linkTaps = new Map<number, number[]>();
  const linksLimit = deps.linksRateLimit ?? { max: 5, windowMs: 60_000 };

  /** Rate limit for "show my links": true (and counted) if this tap may proceed. */
  function allowLinks(telegramId: number): boolean {
    const now = Date.now();
    const recent = (linkTaps.get(telegramId) ?? []).filter((t) => now - t < linksLimit.windowMs);
    if (recent.length >= linksLimit.max) return false;
    recent.push(now);
    linkTaps.set(telegramId, recent);
    if (linkTaps.size > 10_000) linkTaps.clear();
    return true;
  }

  const remainingOf = (order: Order, links: { number: number }[]) =>
    order.status === 'delivered' ? 0 : Math.max(0, order.quantity - links.filter((l) => l.number <= order.quantity).length);

  /**
   * "show my links": sends the order's open links again, as new messages. Activated links are
   * closed and never sent again.
   */
  async function showLinks(telegramId: number, orderId: string): Promise<'sent' | 'none' | 'closed' | 'not_found'> {
    const order = await findOwnOrder(db, telegramId, orderId);
    if (!order) return 'not_found';
    const links = await deliveredLinks(db, order.id);
    if (links.length === 0) return 'none';
    const open = links.filter((l) => !l.activatedAt);
    if (open.length === 0) {
      await port.send(telegramId, {
        text: `every link in order ${order.orderNo} is activated, so they're closed. enjoy google ai pro ✅`,
        keyboard: [[supportButton(facts, order.orderNo)]],
      });
      return 'closed';
    }
    const parts = linksMessages({ orderNo: order.orderNo, quantity: order.quantity, links: open, mode: 'again', remaining: remainingOf(order, links), facts });
    for (const part of parts) {
      const messageId = await port.send(telegramId, part);
      await recordLinkMessage(db, part.itemIds, messageId);
    }
    return 'sent';
  }

  // ------------------------------------------------------------ activation

  /** Redraws buyer messages that show this order's links, so closed links disappear from all of them. */
  async function refreshLinkMessages(order: Order, messageIds: Iterable<number>): Promise<void> {
    const all = await deliveredLinks(db, order.id);
    for (const messageId of new Set(messageIds)) {
      const links = await linksInMessage(db, order.id, messageId);
      if (links.length === 0) continue;
      const parts = linksMessages({
        orderNo: order.orderNo,
        quantity: order.quantity,
        links,
        mode: links.every((l) => l.number > order.quantity) ? 'replacement' : 'again',
        remaining: remainingOf(order, all),
        facts,
      });
      // Closing links only shortens a message, so it still fits in one.
      if (parts.length !== 1 || !parts[0]) {
        logger.warn({ orderId: order.id, messageId }, 'links message too long to redraw');
        continue;
      }
      await port.edit(order.telegramId, messageId, parts[0]);
    }
  }

  /**
   * The ✅ under a link: 'ask' swaps it for a confirmation, 'yes' closes the link everywhere it is
   * shown, 'no' puts the buttons back. False if the link is not this buyer's.
   */
  async function activationTap(telegramId: number, messageId: number, itemId: string, step: 'ask' | 'yes' | 'no'): Promise<boolean> {
    const found = await findOwnLink(db, telegramId, itemId);
    if (!found) return false;
    const { item, order } = found;
    if (step === 'ask' && !item.activatedAt) {
      const shown = (await linksInMessage(db, order.id, messageId)).length;
      await port.setButtons(telegramId, messageId, activationConfirm(item.id, linkLabel(item.idx + 1, order.quantity, shown)));
      return true;
    }
    if (step === 'yes') {
      const closed = await closeLinks(db, order.id, [item.id]);
      if (closed.length > 0) logger.info({ orderId: order.id, orderNo: order.orderNo, idx: item.idx }, 'link activated by the buyer');
      await refreshLinkMessages(order, [messageId, ...item.messageIds]);
      return true;
    }
    await refreshLinkMessages(order, [messageId]);
    return true;
  }

  // ------------------------------------------------------------ help, start, reminders

  async function showHelp(telegramId: number, page: HelpPage | 'hub', editMessageId?: number): Promise<void> {
    const view = page === 'hub' ? helpHub(facts) : helpView(page, facts, await getOfferText(db));
    await sendOrEdit(telegramId, view, editMessageId);
  }

  async function showStart(telegramId: number, firstName: string | undefined): Promise<void> {
    await port.send(telegramId, startMessage(firstName, facts, await getOfferText(db)));
  }

  /** The reminder's buttons: "yes" closes every link of the order, "i need help" brings in support. */
  async function answerActivation(
    telegramId: number,
    messageId: number,
    orderId: string,
    answer: 'yes' | 'help',
    username: string | undefined,
  ): Promise<boolean> {
    const order = await findOwnOrder(db, telegramId, orderId);
    if (!order) return false;
    if (answer === 'yes') {
      const closed = await closeLinks(db, order.id);
      await db
        .update(orders)
        .set({ activatedConfirmedAt: sql`now()` })
        .where(and(eq(orders.id, order.id), isNull(orders.activatedConfirmedAt)));
      await port.edit(telegramId, messageId, activatedReply(order));
      await refreshLinkMessages(order, closed.flatMap((c) => c.messageIds));
    } else {
      await port.edit(telegramId, messageId, activationHelpReply(order, facts));
      deps.notify({
        level: 'warning',
        title: 'buyer needs help activating',
        body: `Order ${order.orderNo} (${username ? `@${username}` : `user ${telegramId}`}) tapped "i need help" on the activation reminder.`,
      });
    }
    return true;
  }

  return {
    startBuy,
    changeQuantity,
    cancelFromCard,
    cancelPending,
    showHistory,
    showOrder,
    showOrderByNo,
    allowLinks,
    showLinks,
    showHelp,
    showStart,
    answerActivation,
    activationTap,
    orderChanged,
    whenIdle,
    availableFor,
    paymentWindowMinutes: PAYMENT_WINDOW_MINUTES,
  };
}

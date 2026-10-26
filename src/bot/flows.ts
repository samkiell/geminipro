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
  deleteOrderDraft,
  deliveredLinks,
  expireUnpaidOrders,
  findOwnLink,
  findOwnOrder,
  findOwnOrderByNo,
  findPendingOrder,
  getOrderDraft,
  historyPage,
  linksInMessage,
  PAYMENT_WINDOW_MINUTES,
  recordLinkMessage,
  reservedUnits,
  saveOrderDraft,
  setOrderMessages,
  UNPAID_OPEN,
  type CreateOrderDeps,
  type CreateOrderResult,
} from '../services/orders.js';
import type { PaymentProvider } from '../services/payments.js';
import { priceFor, type PricingConfig } from '../services/pricing.js';
import { ensureRefCode, referralLink, referralProgress, type ReferralConfig } from '../services/referrals.js';
import type { ResellerClient } from '../services/reseller.js';
import { getOfferText, isPaused } from '../services/settings.js';
import type { Logger } from '../util/logger.js';
import type { OutMessage, TelegramPort } from './telegram.js';
import {
  activatedReply,
  activationConfirm,
  activationHelpReply,
  cb,
  FINAL_OUTCOMES,
  draftCard,
  gateCard,
  helpHub,
  helpView,
  historyList,
  inviteView,
  linkLabel,
  linksMessages,
  orderCard,
  paymentCard,
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
  gateChannel?: string;
  gateChannelUrl?: string;
  adminUserIds?: readonly number[];
  /** Bachs session length (BACHS_SESSION_TTL_MINUTES). Default 15. */
  paymentWindowMinutes?: number;
  /** Referral program; without it /invite is not offered. */
  referral?: ReferralConfig;
  /** Minimum gap between two edits of one status message. Default 1.2s. */
  statusThrottleMs?: number;
  /** Per buyer, "show my links". Default 5 a minute. */
  linksRateLimit?: { max: number; windowMs: number };
}

export type BuyOutcome =
  | { ok: true; orderNo?: string; quantity: number; totalNgn: number; maxQuantity: number }
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
    ...(deps.paymentWindowMinutes && { paymentWindowMinutes: deps.paymentWindowMinutes }),
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
      case 'paid':
      case 'fulfilling':
      case 'partial':
        return 'getting';
      case 'needs_attention':
        return order.paidAt ? 'late' : 'held';
      case 'delivered':
      case 'expired':
      case 'cancelled':
      case 'refunded':
        return order.status;
    }
  }

  async function sync(orderId: string): Promise<void> {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return;
    const chat = order.telegramId;

    // The payment card follows the order in place: "✅ paid, getting your links…", then
    // "🎉 delivered". A final state is applied once (claim first, edit second).
    const outcome = summaryOutcome(order);
    if (outcome && order.summaryMessageId) {
      if (FINAL_OUTCOMES.includes(outcome)) {
        const [claimed] = await db
          .update(orders)
          .set({ summaryMessageId: null, payMessageId: null })
          .where(and(eq(orders.id, orderId), eq(orders.summaryMessageId, order.summaryMessageId)))
          .returning({ id: orders.id });
        if (claimed) await port.edit(chat, order.summaryMessageId, summaryResolved(order, outcome));
      } else {
        await port.edit(chat, order.summaryMessageId, summaryResolved(order, outcome));
      }
    }

    // Older orders that still have a separate status message keep it up to date.
    if (order.statusMessageId) {
      const status = renderStatus(order, facts);
      const result = await port.edit(chat, order.statusMessageId, status);
      if (result === 'gone') await sendStatus(order, status);
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

  let lastGateAlert = 0;
  async function checkGateMember(telegramId: number): Promise<boolean> {
    if (!deps.gateChannel) return true;
    if (deps.adminUserIds?.includes(telegramId)) return true;
    try {
      const member = await port.getChatMember(deps.gateChannel, telegramId);
      if (!member) return false;
      const status = member.status;
      if (status === 'creator' || status === 'administrator' || status === 'member') return true;
      if (status === 'restricted' && Boolean(member.isMember)) return true;
      return false;
    } catch (err) {
      // Fail open: if getChatMember errors (bot not admin, Telegram error), let the buyer through
      // and alert the admin through the notifier with a 30 minute cooldown.
      const now = Date.now();
      if (now - lastGateAlert > 30 * 60 * 1000) {
        lastGateAlert = now;
        deps.notify({
          level: 'warning',
          title: 'channel gate check failed (failed open)',
          body: `getChatMember for ${deps.gateChannel} failed: ${(err as Error).message}`,
        });
      }
      return true;
    }
  }

  /** Shows an unpaid order's payment card at the bottom of the chat, deleting the old copy. */
  async function movePaymentCard(order: Order): Promise<number> {
    if (order.summaryMessageId) {
      await port.delete(order.telegramId, order.summaryMessageId).catch(() => {});
    }
    const available = await availableFor(order);
    const card = paymentCard({ order, facts });
    const cardId = await port.send(order.telegramId, card);
    await setOrderMessages(db, order.id, { summaryMessageId: cardId, payMessageId: cardId });
    return available;
  }

  /** /buy, the buy buttons, the agent and the scripted fallback all start here. */
  async function startBuy(telegramId: number, requested: number): Promise<BuyOutcome> {
    for (const expired of await expireUnpaidOrders(db, telegramId)) orderChanged(expired.id);

    if (await isPaused(db)) {
      await port.send(telegramId, { text: 'sales are paused for a moment. please check back shortly.' });
      return { ok: false, reason: 'paused' };
    }
    if (deps.salesCutoff && new Date() >= deps.salesCutoff) {
      await port.send(telegramId, { text: 'sales have closed. thank you for your interest!' });
      return { ok: false, reason: 'closed' };
    }

    // One active unpaid order per user. If they already have one and press buy again, show that same payment card.
    const pending = await findPendingOrder(db, telegramId);
    if (pending) {
      return okOutcome(pending, await movePaymentCard(pending));
    }

    const available = await availableFor();
    if (available < 1) {
      await port.send(telegramId, {
        text: "we're out of links right now. please check back soon.",
        keyboard: [[supportButton(facts)]],
      });
      return { ok: false, reason: 'unavailable', maxQuantity: 0 };
    }

    if (requested > available) {
      await port.send(telegramId, {
        text: `i can sell up to ${available} right now.`,
        keyboard: [[{ text: `buy ${available}`, data: cb.buy(available) }]],
      });
      return { ok: false, reason: 'unavailable', maxQuantity: available };
    }

    const quantity = Math.min(Math.max(Math.trunc(requested) || 1, 1), available);
    const existingDraft = await getOrderDraft(db, telegramId);
    if (existingDraft?.messageId) {
      await port.delete(telegramId, existingDraft.messageId).catch(() => {});
    }

    const [maxQuantity, offerText] = await Promise.all([availableFor(), getOfferText(db)]);
    const price = priceFor(quantity, deps.pricing);
    const card = draftCard({
      quantity,
      unitPriceNgn: facts.unitPriceNgn,
      totalNgn: price.totalNgn,
      maxQuantity,
      offerText,
      facts,
    });
    const messageId = await port.send(telegramId, card);
    await saveOrderDraft(db, { telegramId, quantity, messageId });
    return { ok: true, quantity, totalNgn: price.totalNgn, maxQuantity };
  }

  /** The − and + buttons on the draft card. */
  async function changeDraftQuantity(telegramId: number, messageId: number, requested: number): Promise<BuyOutcome> {
    const draft = await getOrderDraft(db, telegramId);
    if (!draft || draft.messageId !== messageId) {
      return { ok: false, reason: 'stale' };
    }
    const maxQuantity = await availableFor();
    if (maxQuantity < 1) {
      return { ok: false, reason: 'unavailable', maxQuantity: 0 };
    }
    const quantity = Math.min(Math.max(Math.trunc(requested) || 1, 1), maxQuantity);
    const offerText = await getOfferText(db);
    const price = priceFor(quantity, deps.pricing);
    const card = draftCard({
      quantity,
      unitPriceNgn: facts.unitPriceNgn,
      totalNgn: price.totalNgn,
      maxQuantity,
      offerText,
      facts,
    });
    await port.edit(telegramId, messageId, card);
    await saveOrderDraft(db, { telegramId, quantity, messageId });
    return { ok: true, quantity, totalNgn: price.totalNgn, maxQuantity };
  }

  /** The draft card cancel button. */
  async function cancelDraft(telegramId: number, messageId: number): Promise<void> {
    await deleteOrderDraft(db, telegramId);
    await port.edit(telegramId, messageId, { text: 'cancelled', keyboard: undefined });
  }

  /**
   * On [continue]:
   * (1) run channel check
   * (2) recheck availability and clamp
   * (3) create ONE order with final quantity and ONE Bachs checkout session
   * (4) edit the same message into payment card
   * (5) delete the draft
   */
  async function continueDraft(
    telegramId: number,
    messageId: number,
  ): Promise<
    | { ok: true; order: Order }
    | { ok: false; reason: 'gate_required' | 'stale' | Exclude<CreateOrderResult, { ok: true }>['reason'] }
  > {
    const draft = await getOrderDraft(db, telegramId);
    if (!draft || draft.messageId !== messageId) {
      return { ok: false, reason: 'stale' };
    }

    const isMember = await checkGateMember(telegramId);
    if (!isMember) {
      const channelUrl = deps.gateChannelUrl ?? `https://t.me/${deps.gateChannel?.replace(/^@/, '') ?? 'samkieldevtg'}`;
      const gate = gateCard(channelUrl);
      await port.edit(telegramId, messageId, gate);
      return { ok: false, reason: 'gate_required' };
    }

    const maxQuantity = await availableFor();
    if (maxQuantity < 1) {
      await port.edit(telegramId, messageId, {
        text: "we're out of links right now. please check back soon.",
        keyboard: [[supportButton(facts)]],
      });
      return { ok: false, reason: 'unavailable' };
    }
    const finalQuantity = Math.min(draft.quantity, maxQuantity);

    const result = await createOrder(orderDeps(), { telegramId, quantity: finalQuantity });
    if (!result.ok) {
      await refuse(telegramId, result, finalQuantity);
      return { ok: false, reason: result.reason };
    }
    const order = result.order;

    const card = paymentCard({ order, facts });
    await port.edit(telegramId, messageId, card);
    await setOrderMessages(db, order.id, { summaryMessageId: messageId, payMessageId: messageId });
    await deleteOrderDraft(db, telegramId);

    return { ok: true, order };
  }

  /** Channel gate "i have joined ✅" button. */
  async function recheckGate(telegramId: number, messageId: number, queryId: string): Promise<boolean> {
    const isMember = await checkGateMember(telegramId);
    if (!isMember) {
      await port.answer(queryId, "you haven't joined yet", true);
      return false;
    }
    await port.answer(queryId);
    const draft = await getOrderDraft(db, telegramId);
    const quantity = draft?.quantity ?? 1;
    const [maxQuantity, offerText] = await Promise.all([availableFor(), getOfferText(db)]);
    const price = priceFor(quantity, deps.pricing);
    const card = draftCard({
      quantity,
      unitPriceNgn: facts.unitPriceNgn,
      totalNgn: price.totalNgn,
      maxQuantity,
      offerText,
      facts,
    });
    await port.edit(telegramId, messageId, card);
    await saveOrderDraft(db, { telegramId, quantity, messageId });
    return true;
  }

  /** Legacy / order stepper helper. */
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
      return okOutcome(old, await movePaymentCard(old));
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
      await setOrderMessages(db, old.id, { summaryMessageId: null, payMessageId: null, statusMessageId: null });
      await setOrderMessages(db, order.id, {
        summaryMessageId: old.summaryMessageId,
        payMessageId: old.payMessageId,
        statusMessageId: old.statusMessageId,
      });
      const [maxQuantity, offerText] = await Promise.all([availableFor(order), getOfferText(db)]);
      const result = await port.edit(chat, editMessageId, summaryCard({ order, maxQuantity, offerText, facts }));
      if (result !== 'ok') return okOutcome(order, await movePaymentCard({ ...order, summaryMessageId: null }));
      if (old.statusMessageId) await port.edit(chat, old.statusMessageId, renderStatus(order, facts));
      return okOutcome(order, maxQuantity);
    }

    orderChanged(cancelled.id);
    return okOutcome(order, await presentOrder(order));
  }

  /** The − and + buttons (supports draft or order). */
  async function changeQuantity(telegramId: number, messageId: number, orderId: string, target: number): Promise<BuyOutcome> {
    const draft = await getOrderDraft(db, telegramId);
    if (draft && draft.messageId === messageId) {
      return changeDraftQuantity(telegramId, messageId, target);
    }
    const order = await findOwnOrder(db, telegramId, orderId);
    if (!order || order.status !== 'awaiting_payment' || order.summaryMessageId !== messageId) {
      return { ok: false, reason: 'stale' };
    }
    return replaceOrder(order, target, messageId);
  }

  /** The card's cancel button. */
  async function cancelFromCard(telegramId: number, orderId: string, messageId?: number): Promise<boolean> {
    const cancelled = await cancelOwnOrder(db, telegramId, orderId);
    if (cancelled) {
      orderChanged(cancelled.id);
      if (messageId) {
        await port.edit(telegramId, messageId, { text: 'cancelled', keyboard: undefined });
      }
    }
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

  /** /invite and the [invite & earn 🎁] buttons: one message, edited in place when asked. */
  async function showInvite(telegramId: number, editMessageId?: number): Promise<void> {
    const referral = deps.referral;
    if (!referral) return;
    const [code, progress] = await Promise.all([ensureRefCode(db, telegramId), referralProgress(db, telegramId, referral)]);
    const view = inviteView({
      link: referralLink(referral.botUsername, code),
      threshold: referral.threshold,
      maxRewards: referral.maxRewards,
      qualified: progress.qualified,
      earned: progress.granted + progress.due,
      capReached: progress.capReached,
    });
    await sendOrEdit(telegramId, view, editMessageId);
  }

  async function showStart(telegramId: number, firstName: string | undefined): Promise<void> {
    const existing = await db.select({ id: orders.id }).from(orders).where(eq(orders.telegramId, telegramId)).limit(1);
    await port.send(telegramId, startMessage(firstName, facts, await getOfferText(db), existing.length > 0));
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
    changeDraftQuantity,
    cancelDraft,
    continueDraft,
    recheckGate,
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
    showInvite,
    answerActivation,
    activationTap,
    orderChanged,
    whenIdle,
    availableFor,
    paymentWindowMinutes: deps.paymentWindowMinutes ?? PAYMENT_WINDOW_MINUTES,
  };
}

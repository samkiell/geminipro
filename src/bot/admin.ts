import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Bot, Context } from 'grammy';
import type { Db } from '../db/client.js';
import { events, orderItems, orders, users, type Order } from '../db/schema.js';
import { latestLeads } from '../services/leads.js';
import type { Notify } from '../services/notifier.js';
import { findOrderByNo, recordLinkMessage, reservedUnits } from '../services/orders.js';
import type { ResellerClient } from '../services/reseller.js';
import { activeProof, addProof, MAX_PROOF, removeProof } from '../services/proof.js';
import { getOfferText, isPaused, setOfferText, setPaused } from '../services/settings.js';
import { referralStats } from '../services/referrals.js';
import { activationLine, referralLine, salesStats } from '../services/stats.js';
import type { Logger } from '../util/logger.js';
import type { Flows } from './flows.js';
import type { Keyboard, OutMessage, TelegramPort } from './telegram.js';
import { linksMessages, naira, watDateTime, type UiFacts } from './views.js';

// Admin commands (docs/PRD.md 8.8), only for ADMIN_TELEGRAM_IDS. For anyone else these commands
// do not exist: they fall through to the buyer side, which answers like any unknown command.
// Everything is also reachable from the /admin panel; actions that need a value ask for a reply.

export interface AdminDeps {
  db: Db;
  port: TelegramPort;
  logger: Logger;
  facts: UiFacts;
  adminIds: number[];
  reseller: Pick<ResellerClient, 'getBalance' | 'getProduct' | 'createOrder'>;
  productId: number;
  flows: Pick<Flows, 'orderChanged'>;
  notify: Notify;
}

const PANEL_TEXT = [
  'admin panel. tap a button, or type a command:',
  '/order GP-1042 · /resend GP-1042 · /replace GP-1042',
  '/offertext <text> · /pause · /resume',
  '/stats · /balance · /allorders · /leads · /proofs',
].join('\n');
const PANEL: Keyboard = [
  [
    { text: 'balance', data: 'ad:p:balance' },
    { text: 'stats', data: 'ad:p:stats' },
  ],
  [
    { text: 'all orders', data: 'ad:p:orders' },
    { text: 'find an order', data: 'ad:ask:order' },
  ],
  [
    { text: 'leads', data: 'ad:p:leads' },
    { text: 'offer text', data: 'ad:p:offer' },
  ],
  [{ text: 'proof screenshots', data: 'ad:p:proofs' }],
  [
    { text: 'pause sales', data: 'ad:p:pause' },
    { text: 'resume sales', data: 'ad:p:resume' },
  ],
];
const BACK: Keyboard = [[{ text: '‹ panel', data: 'ad:p:home' }]];

// Prompts that open the reply box; the admin's reply is matched back to them by their text.
const ASK = {
  order: 'find an order: reply to this message with its number, like GP-1042.',
  offer: 'new offer line: reply to this message with the text. no dates.',
};

const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const DATE_LIKE = new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}\\b|\\b20\\d{2}\\b`, 'i');

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function registerAdmin(bot: Bot, deps: AdminDeps): void {
  const { db, port } = deps;
  const admin = bot.filter((ctx): ctx is Context & { from: NonNullable<Context['from']> } =>
    ctx.from !== undefined && deps.adminIds.includes(ctx.from.id),
  );
  const reply = (ctx: Context, message: OutMessage) => port.send(ctx.chat?.id ?? 0, message);

  // ------------------------------------------------------------ views

  async function balanceView(): Promise<string> {
    try {
      const [balance, product, reserved, paused] = await Promise.all([
        deps.reseller.getBalance(),
        deps.reseller.getProduct(deps.productId),
        reservedUnits(db),
        isPaused(db),
      ]);
      const covers = product.priceCents > 0 ? Math.floor(balance.balanceCents / product.priceCents) : 0;
      return [
        `balance: $${(balance.balanceCents / 100).toFixed(2)} (covers ${covers} links at $${(product.priceCents / 100).toFixed(2)})`,
        `stock: ${product.stock}${product.inStock ? '' : ' (out of stock)'}`,
        `links promised to open orders: ${reserved}`,
        `links you can still sell: ${Math.max(0, Math.min(covers, product.stock) - reserved)}`,
        `sales: ${paused ? 'paused' : 'on'}`,
      ].join('\n');
    } catch (err) {
      return `could not reach the reseller: ${(err as Error).message}`;
    }
  }

  async function statsView(): Promise<string> {
    const [s, refs, priceCents] = await Promise.all([
      salesStats(db),
      referralStats(db),
      deps.reseller
        .getProduct(deps.productId)
        .then((p) => p.priceCents)
        .catch(() => undefined),
    ]);
    return [
      `today: ${s.today.orders} orders, ${s.today.links} links, ${naira(s.today.revenueNgn)}`,
      `total: ${s.total.orders} orders, ${s.total.links} links, ${naira(s.total.revenueNgn)}`,
      `in progress: ${s.inProgress} · failures: ${s.failures} · waiting for payment: ${s.pending}`,
      activationLine(s.activation),
      referralLine(refs, priceCents),
    ].join('\n');
  }

  /** The last 10 paid orders, each a button that opens it. */
  async function ordersView(): Promise<OutMessage> {
    const rows = await db
      .select({ order: orders, username: users.username })
      .from(orders)
      .leftJoin(users, eq(users.telegramId, orders.telegramId))
      .where(isNotNull(orders.paidAt))
      .orderBy(desc(orders.createdAt))
      .limit(10);
    if (rows.length === 0) return { text: 'no paid orders yet.', keyboard: BACK };
    const status = (o: Order) => `${o.status.replace('_', ' ')}${o.activatedConfirmedAt ? ', activated' : ''}`;
    return {
      text: [
        'last 10 paid orders. tap one to open it.',
        ...rows.map(
          ({ order: o, username }) =>
            `${o.orderNo} · ${o.quantity} · ${naira(o.amountNgn)} · ${status(o)} · ${username ? `@${username}` : o.telegramId} · ${watDateTime(o.createdAt)}`,
        ),
      ].join('\n'),
      keyboard: [...rows.map(({ order: o }) => [{ text: `${o.orderNo} · ${status(o)}`, data: `ad:o:${o.id}` }]), ...BACK],
    };
  }

  async function leadsView(): Promise<string> {
    const rows = await latestLeads(db, 10);
    if (rows.length === 0) return 'no leads yet.';
    return rows
      .map((l) => `${l.username ? `@${l.username}` : l.telegramId}: ${l.summary} · ${watDateTime(l.createdAt)}`)
      .join('\n');
  }

  /** The album by id (ids never shift when one is removed), with a remove button for each. */
  async function proofsView(note?: string): Promise<OutMessage> {
    const items = await activeProof(db);
    const head = note ? [note] : [];
    if (items.length === 0) {
      return { text: [...head, 'no proof screenshots yet. send a photo with the caption /addproof.'].join('\n'), keyboard: BACK };
    }
    return {
      text: [
        ...head,
        `proof album (${items.length} of ${MAX_PROOF}), in order:`,
        ...items.map((p) => `#${p.id} ${p.key.startsWith('tg:') ? 'sent in telegram' : p.key}${p.fileId ? '' : ' (not uploaded yet)'}`),
        'tap one to remove it, or send /delproof <id>.',
      ].join('\n'),
      keyboard: [...items.map((p) => [{ text: `🗑 remove #${p.id}`, data: `ad:pd:${p.id}` }]), ...BACK],
    };
  }

  async function deleteProof(id: number): Promise<OutMessage> {
    const removed = Number.isInteger(id) && id > 0 ? await removeProof(db, id) : undefined;
    return proofsView(removed ? `removed #${id}.` : `there is no screenshot #${id}.`);
  }

  async function offerView(): Promise<OutMessage> {
    return {
      text: `offer line: "${await getOfferText(db)}"\nchange it with the button or /offertext <text> (no dates).`,
      keyboard: [[{ text: 'change offer text', data: 'ad:ask:offer' }], ...BACK],
    };
  }

  /** One order, links never shown: resend, send them to me, replace. */
  async function orderView(order: Order): Promise<OutMessage> {
    const [user] = await db.select().from(users).where(eq(users.telegramId, order.telegramId));
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(asc(orderItems.idx));
    const itemLines = items.map((i) =>
      [
        `link ${i.idx + 1}${i.idx >= order.quantity ? ' (replacement)' : ''}: ${i.status}`,
        ...(i.deliveredAt ? ['delivered'] : []),
        ...(i.activatedAt ? [`activated ${watDateTime(i.activatedAt)}`] : []),
      ].join(', ') + (i.error ? ` (${i.error})` : ''),
    );
    const hasLinks = items.some((i) => i.activationLink);
    const keyboard: Keyboard = [];
    if (hasLinks) {
      keyboard.push([
        { text: 'resend to buyer', data: `ad:resend:${order.id}` },
        { text: 'send me the links', data: `ad:links:${order.id}` },
      ]);
    }
    if (order.paidAt) keyboard.push([{ text: 'replace a link', data: `ad:replace:${order.id}` }]);
    keyboard.push([
      { text: '‹ all orders', data: 'ad:p:orders' },
      { text: '‹ panel', data: 'ad:p:home' },
    ]);
    return {
      text: [
        `${order.orderNo} · ${order.status.replace('_', ' ')}${order.activatedConfirmedAt ? ' · activated ✅' : ''}`,
        `buyer: ${user?.username ? `@${user.username}` : (user?.firstName ?? '')} (${order.telegramId})${user?.blocked ? ' · blocked the bot' : ''}`,
        `${order.quantity} links · ${naira(order.amountNgn)}${deps.facts.grossUp ? '' : ' + fee'}`,
        `ordered ${watDateTime(order.createdAt)}${order.paidAt ? ` · paid ${watDateTime(order.paidAt)}` : ''}${order.deliveredAt ? ` · delivered ${watDateTime(order.deliveredAt)}` : ''}`,
        ...itemLines,
        ...(order.error ? [`error: ${order.error}`] : []),
        ...(order.checkoutId ? [`checkout: ${order.checkoutId}`] : []),
      ].join('\n'),
      keyboard,
    };
  }

  async function orderFromArg(ctx: Context, arg: string): Promise<Order | undefined> {
    const order = await findOrderByNo(db, arg);
    if (!order) await reply(ctx, { text: arg.trim() ? `no order ${arg.trim()}.` : 'which order? for example /order GP-1042' });
    return order;
  }

  // ------------------------------------------------------------ actions

  /**
   * Sends the order's open links (bought ones not yet delivered too) to the buyer again. Links the
   * buyer marked activated are closed and never resent.
   */
  async function resend(order: Order): Promise<string> {
    const items = await db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), isNotNull(orderItems.activationLink)))
      .orderBy(asc(orderItems.idx));
    if (items.length === 0) return `${order.orderNo} has no links yet.`;
    const open = items.filter((i) => !i.activatedAt);
    if (open.length === 0) return `every link of ${order.orderNo} is activated and closed. nothing to resend.`;
    const parts = linksMessages({
      orderNo: order.orderNo,
      quantity: order.quantity,
      links: open.map((i) => ({ number: i.idx + 1, link: i.activationLink as string, itemId: i.id })),
      mode: 'again',
      remaining: Math.max(0, order.quantity - items.filter((i) => i.idx < order.quantity).length),
      facts: deps.facts,
    });
    try {
      for (const part of parts) await recordLinkMessage(db, part.itemIds, await port.send(order.telegramId, part));
    } catch (err) {
      return `could not send to the buyer: ${(err as Error).message}`;
    }
    // Everything ordered is now delivered: close out an order that was stuck on delivery.
    if (items.filter((i) => i.idx < order.quantity).length === order.quantity) {
      await db
        .update(orders)
        .set({ status: 'delivered', deliveredAt: sql`coalesce(${orders.deliveredAt}, now())`, error: null })
        .where(and(eq(orders.id, order.id), isNotNull(orders.paidAt), inArray(orders.status, ['needs_attention', 'partial', 'paid'])));
    }
    await db.update(users).set({ blocked: false }).where(eq(users.telegramId, order.telegramId));
    deps.flows.orderChanged(order.id);
    const closed = items.length - open.length;
    return `sent ${open.length} ${plural(open.length, 'link', 'links')} of ${order.orderNo} to the buyer.${
      closed > 0 ? ` ${closed} activated (closed) ${plural(closed, 'was', 'were')} not resent.` : ''
    }`;
  }

  /**
   * Buys one more link through the normal reseller path, sends it to the buyer and records it.
   * The key comes from the admin's command or confirm button, so a repeat can never buy twice.
   */
  async function replace(order: Order, requestKey: string): Promise<string> {
    if (!order.paidAt) return `${order.orderNo} is not paid.`;
    const idempotencyKey = `${order.id}-r-${requestKey}`;
    let bought: { orderCode: string; value: string };
    try {
      bought = await deps.reseller.createOrder(deps.productId, idempotencyKey);
    } catch (err) {
      return `could not buy a replacement: ${(err as Error).message}`;
    }
    const [{ next } = { next: order.quantity }] = await db
      .select({ next: sql<number>`greatest(coalesce(max(${orderItems.idx}) + 1, 0), ${order.quantity})::int` })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    const [item] = await db
      .insert(orderItems)
      .values({
        orderId: order.id,
        idx: next,
        idempotencyKey,
        status: 'completed',
        resellerOrderCode: bought.orderCode,
        activationLink: bought.value,
      })
      .onConflictDoNothing()
      .returning({ id: orderItems.id, idx: orderItems.idx });
    if (!item) return `that replacement for ${order.orderNo} was already bought. use /resend ${order.orderNo} if the buyer did not get it.`;
    await db.insert(events).values({
      kind: 'replacement',
      ref: order.id,
      payload: { orderNo: order.orderNo, idx: item.idx, orderCode: bought.orderCode },
    });
    const [message] = linksMessages({
      orderNo: order.orderNo,
      quantity: order.quantity,
      links: [{ number: item.idx + 1, link: bought.value, itemId: item.id }],
      mode: 'replacement',
      remaining: 0,
      facts: deps.facts,
    });
    try {
      if (message) await recordLinkMessage(db, message.itemIds, await port.send(order.telegramId, message));
    } catch (err) {
      return `bought a replacement for ${order.orderNo} but could not send it: ${(err as Error).message}. use "send me the links".`;
    }
    deps.logger.info({ orderId: order.id, orderCode: bought.orderCode }, 'replacement link sent');
    return `replacement for ${order.orderNo} bought and sent to the buyer.`;
  }

  /** The links in the admin's own chat (to pass on by WhatsApp). Activated ones stay closed. */
  async function linksToAdmin(ctx: Context, order: Order): Promise<void> {
    const items = await db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), isNotNull(orderItems.activationLink)))
      .orderBy(asc(orderItems.idx));
    if (items.length === 0) {
      await reply(ctx, { text: `${order.orderNo} has no links yet.` });
      return;
    }
    const parts = linksMessages({
      orderNo: order.orderNo,
      quantity: order.quantity,
      links: items.map((i) => ({ number: i.idx + 1, link: i.activationLink as string, activatedAt: i.activatedAt })),
      mode: 'again',
      remaining: 0,
      facts: deps.facts,
    });
    for (const part of parts) await reply(ctx, { text: part.text, html: true });
  }

  async function changeOffer(text: string): Promise<string> {
    if (!text) return `offer line: "${await getOfferText(db)}"\nchange it with /offertext <text> (no dates).`;
    if (DATE_LIKE.test(text)) return 'the offer line must not contain a date. try something like "last 30 links left".';
    await setOfferText(db, text.toLowerCase());
    return `offer line is now: "${await getOfferText(db)}"`;
  }

  // ------------------------------------------------------------ commands

  admin.command('admin', async (ctx) => {
    await reply(ctx, { text: PANEL_TEXT, keyboard: PANEL });
  });
  admin.command('balance', async (ctx) => {
    await reply(ctx, { text: await balanceView() });
  });
  admin.command('stats', async (ctx) => {
    await reply(ctx, { text: await statsView() });
  });
  admin.command('allorders', async (ctx) => {
    await reply(ctx, await ordersView());
  });
  admin.command('leads', async (ctx) => {
    await reply(ctx, { text: await leadsView() });
  });
  admin.command('order', async (ctx) => {
    const order = await orderFromArg(ctx, ctx.match);
    if (order) await reply(ctx, await orderView(order));
  });
  admin.command('resend', async (ctx) => {
    const order = await orderFromArg(ctx, ctx.match);
    if (order) await reply(ctx, { text: await resend(order) });
  });
  admin.command('replace', async (ctx) => {
    const order = await orderFromArg(ctx, ctx.match);
    if (order) await reply(ctx, { text: await replace(order, `m${ctx.msg?.message_id ?? Date.now()}`) });
  });
  admin.command('pause', async (ctx) => {
    await setPaused(db, true);
    await reply(ctx, { text: 'sales paused. buyers are told to check back shortly. /resume to restart.' });
  });
  admin.command('resume', async (ctx) => {
    await setPaused(db, false);
    await reply(ctx, { text: 'sales are on again.' });
  });
  admin.command('offertext', async (ctx) => {
    await reply(ctx, { text: await changeOffer(ctx.match.trim()) });
  });

  // Proof screenshots: real, with personal details blurred (README checklist). Never generated.
  admin.on('message:photo', async (ctx, next) => {
    if (!/^\/addproof\b/i.test(ctx.message.caption ?? '')) return next();
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    const result = await addProof(db, photo.file_id, photo.file_unique_id);
    await reply(ctx, {
      text: {
        added: `added. the album now has ${(await activeProof(db)).length} of ${MAX_PROOF}. check it with /proofs.`,
        exists: 'that screenshot is already in the album.',
        full: `the album is full (${MAX_PROOF}). remove one with /proofs first.`,
      }[result],
    });
  });
  admin.command('proofs', async (ctx) => {
    await reply(ctx, await proofsView());
  });
  admin.command('delproof', async (ctx) => {
    const arg = ctx.match.trim().replace(/^#/, '');
    await reply(ctx, arg ? await deleteProof(Number(arg)) : await proofsView('which one? tap it below, or send /delproof <id>.'));
  });

  // Replies to the panel's "find an order" and "change offer text" prompts.
  admin.on('message:text', async (ctx, next) => {
    const asked = ctx.message.reply_to_message;
    if (!asked || asked.from?.id !== ctx.me.id) return next();
    const answer = ctx.message.text.trim();
    if (asked.text === ASK.order) {
      const order = await orderFromArg(ctx, answer);
      if (order) await reply(ctx, await orderView(order));
      return;
    }
    if (asked.text === ASK.offer) {
      await reply(ctx, { text: await changeOffer(answer), keyboard: BACK });
      return;
    }
    return next();
  });

  // ------------------------------------------------------------ panel and order buttons

  admin.callbackQuery(/^ad:/, async (ctx) => {
    const [, kind = '', arg = '', extra = ''] = ctx.callbackQuery.data.split(':');
    const chat = ctx.from.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    await port.answer(ctx.callbackQuery.id);

    // Panel views edit the panel message in place.
    const show = async (message: OutMessage) => {
      if (messageId && (await port.edit(chat, messageId, message)) === 'ok') return;
      await port.send(chat, message);
    };

    if (kind === 'p') {
      if (arg === 'home') return show({ text: PANEL_TEXT, keyboard: PANEL });
      if (arg === 'balance') return show({ text: await balanceView(), keyboard: BACK });
      if (arg === 'stats') return show({ text: await statsView(), keyboard: BACK });
      if (arg === 'orders') return show(await ordersView());
      if (arg === 'leads') return show({ text: await leadsView(), keyboard: BACK });
      if (arg === 'offer') return show(await offerView());
      if (arg === 'proofs') return show(await proofsView());
      if (arg === 'pause' || arg === 'resume') {
        await setPaused(db, arg === 'pause');
        return show({ text: arg === 'pause' ? 'sales paused.' : 'sales are on again.', keyboard: BACK });
      }
      return;
    }
    if (kind === 'pd') return show(await deleteProof(Number(arg)));
    if (kind === 'ask') {
      if (arg === 'order') await port.send(chat, { text: ASK.order, forceReply: 'GP-1042' });
      if (arg === 'offer') await port.send(chat, { text: ASK.offer, forceReply: await getOfferText(db) });
      return;
    }

    if (!/^[0-9a-f-]{36}$/i.test(arg)) return;
    const [order] = await db.select().from(orders).where(eq(orders.id, arg));
    if (!order) return;
    if (kind === 'o') return show(await orderView(order));
    if (kind === 'resend') await port.send(chat, { text: await resend(order) });
    if (kind === 'links') await linksToAdmin(ctx, order);
    if (kind === 'replace' && messageId) {
      // A replacement costs money: one more tap to confirm. The nonce makes a double tap one purchase.
      await port.setButtons(chat, messageId, [
        [{ text: `yes, buy and send 1 replacement for ${order.orderNo}`, data: `ad:rk:${order.id}:${Date.now().toString(36)}` }],
        [{ text: 'cancel', data: `ad:o:${order.id}` }],
      ]);
    }
    if (kind === 'rk' && extra) {
      const result = await replace(order, `p${extra}`);
      await show(await orderView(order));
      await port.send(chat, { text: result });
    }
  });
}

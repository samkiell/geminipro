import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Bot, Context } from 'grammy';
import type { Db } from '../db/client.js';
import { events, orderItems, orders, users, type Order } from '../db/schema.js';
import { latestLeads } from '../services/leads.js';
import type { Notify } from '../services/notifier.js';
import { findOrderByNo, reservedUnits } from '../services/orders.js';
import type { ResellerClient } from '../services/reseller.js';
import { getOfferText, isPaused, setOfferText, setPaused } from '../services/settings.js';
import { salesStats } from '../services/stats.js';
import type { Logger } from '../util/logger.js';
import type { Flows } from './flows.js';
import type { Keyboard, OutMessage, TelegramPort } from './telegram.js';
import { linksMessages, naira, watDateTime, type UiFacts } from './views.js';

// Admin commands (docs/PRD.md 8.8), only for ADMIN_TELEGRAM_IDS. For anyone else these commands
// do not exist: they fall through to the buyer side, which answers like any unknown command.

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

const PANEL: Keyboard = [
  [
    { text: 'balance', data: 'ad:p:balance' },
    { text: 'stats', data: 'ad:p:stats' },
  ],
  [
    { text: 'all orders', data: 'ad:p:orders' },
    { text: 'leads', data: 'ad:p:leads' },
  ],
  [
    { text: 'pause sales', data: 'ad:p:pause' },
    { text: 'resume sales', data: 'ad:p:resume' },
  ],
  [{ text: 'offer text', data: 'ad:p:offer' }],
];
const BACK: Keyboard = [[{ text: '‹ panel', data: 'ad:p:home' }]];

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
    const s = await salesStats(db);
    return [
      `today: ${s.today.orders} orders, ${s.today.links} links, ${naira(s.today.revenueNgn)}`,
      `total: ${s.total.orders} orders, ${s.total.links} links, ${naira(s.total.revenueNgn)}`,
      `in progress: ${s.inProgress} · failures: ${s.failures} · waiting for payment: ${s.pending}`,
    ].join('\n');
  }

  async function ordersView(): Promise<string> {
    const rows = await db
      .select({ order: orders, username: users.username })
      .from(orders)
      .leftJoin(users, eq(users.telegramId, orders.telegramId))
      .where(isNotNull(orders.paidAt))
      .orderBy(desc(orders.createdAt))
      .limit(10);
    if (rows.length === 0) return 'no paid orders yet.';
    return rows
      .map(({ order: o, username }) =>
        `${o.orderNo} · ${o.quantity} · ${naira(o.amountNgn)} · ${o.status.replace('_', ' ')} · ${username ? `@${username}` : o.telegramId} · ${watDateTime(o.createdAt)}`,
      )
      .join('\n');
  }

  async function leadsView(): Promise<string> {
    const rows = await latestLeads(db, 10);
    if (rows.length === 0) return 'no leads yet.';
    return rows
      .map((l) => `${l.username ? `@${l.username}` : l.telegramId}: ${l.summary} · ${watDateTime(l.createdAt)}`)
      .join('\n');
  }

  async function orderView(order: Order): Promise<OutMessage> {
    const [user] = await db.select().from(users).where(eq(users.telegramId, order.telegramId));
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(asc(orderItems.idx));
    const itemLines = items.map(
      (i) => `link ${i.idx + 1}${i.idx >= order.quantity ? ' (replacement)' : ''}: ${i.status}${i.deliveredAt ? ', delivered' : ''}${i.error ? ` (${i.error})` : ''}`,
    );
    const hasLinks = items.some((i) => i.activationLink);
    return {
      text: [
        `${order.orderNo} · ${order.status.replace('_', ' ')}`,
        `buyer: ${user?.username ? `@${user.username}` : (user?.firstName ?? '')} (${order.telegramId})${user?.blocked ? ' · blocked the bot' : ''}`,
        `${order.quantity} links · ${naira(order.amountNgn)}${deps.facts.grossUp ? '' : ' + fee'}`,
        `ordered ${watDateTime(order.createdAt)}${order.paidAt ? ` · paid ${watDateTime(order.paidAt)}` : ''}${order.deliveredAt ? ` · delivered ${watDateTime(order.deliveredAt)}` : ''}`,
        ...itemLines,
        ...(order.error ? [`error: ${order.error}`] : []),
        ...(order.checkoutId ? [`checkout: ${order.checkoutId}`] : []),
      ].join('\n'),
      keyboard: hasLinks
        ? [
            [
              { text: 'resend to buyer', data: `ad:resend:${order.id}` },
              { text: 'send me the links', data: `ad:links:${order.id}` },
            ],
            [{ text: 'replace a link', data: `ad:replace:${order.id}` }],
          ]
        : order.paidAt
          ? [[{ text: 'replace a link', data: `ad:replace:${order.id}` }]]
          : [],
    };
  }

  async function orderFromArg(ctx: Context, arg: string): Promise<Order | undefined> {
    const order = await findOrderByNo(db, arg);
    if (!order) await reply(ctx, { text: arg.trim() ? `no order ${arg.trim()}.` : 'which order? for example /order GP-1042' });
    return order;
  }

  // ------------------------------------------------------------ actions

  /** Sends every link the order has (bought ones not yet delivered too) to the buyer again. */
  async function resend(order: Order): Promise<string> {
    const items = await db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), isNotNull(orderItems.activationLink)))
      .orderBy(asc(orderItems.idx));
    if (items.length === 0) return `${order.orderNo} has no links yet.`;
    const parts = linksMessages({
      orderNo: order.orderNo,
      quantity: order.quantity,
      links: items.map((i) => ({ number: i.idx + 1, link: i.activationLink as string })),
      mode: 'again',
      remaining: Math.max(0, order.quantity - items.filter((i) => i.idx < order.quantity).length),
      facts: deps.facts,
    });
    try {
      for (const part of parts) await port.send(order.telegramId, part);
    } catch (err) {
      return `could not send to the buyer: ${(err as Error).message}`;
    }
    await db
      .update(orderItems)
      .set({ deliveredAt: sql`now()` })
      .where(and(eq(orderItems.orderId, order.id), isNull(orderItems.deliveredAt), isNotNull(orderItems.activationLink)));
    // Everything ordered is now delivered: close out an order that was stuck on delivery.
    if (items.filter((i) => i.idx < order.quantity).length === order.quantity) {
      await db
        .update(orders)
        .set({ status: 'delivered', deliveredAt: sql`coalesce(${orders.deliveredAt}, now())`, error: null })
        .where(and(eq(orders.id, order.id), isNotNull(orders.paidAt), inArray(orders.status, ['needs_attention', 'partial', 'paid'])));
    }
    await db.update(users).set({ blocked: false }).where(eq(users.telegramId, order.telegramId));
    deps.flows.orderChanged(order.id);
    return `sent ${items.length} link${items.length === 1 ? '' : 's'} of ${order.orderNo} to the buyer.`;
  }

  /**
   * Buys one more link through the normal reseller path, sends it to the buyer and records it.
   * The key comes from the admin's command, so a retried update can never buy twice.
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
    await db
      .insert(orderItems)
      .values({
        orderId: order.id,
        idx: next,
        idempotencyKey,
        status: 'completed',
        resellerOrderCode: bought.orderCode,
        activationLink: bought.value,
      })
      .onConflictDoNothing();
    const [item] = await db.select().from(orderItems).where(eq(orderItems.idempotencyKey, idempotencyKey));
    await db.insert(events).values({
      kind: 'replacement',
      ref: order.id,
      payload: { orderNo: order.orderNo, idx: item?.idx, orderCode: bought.orderCode },
    });
    const [message] = linksMessages({
      orderNo: order.orderNo,
      quantity: 1,
      links: [{ number: 1, link: bought.value }],
      mode: 'replacement',
      remaining: 0,
      facts: deps.facts,
    });
    try {
      if (message) await port.send(order.telegramId, message);
      await db.update(orderItems).set({ deliveredAt: sql`now()` }).where(eq(orderItems.idempotencyKey, idempotencyKey));
    } catch (err) {
      return `bought a replacement for ${order.orderNo} but could not send it: ${(err as Error).message}. use "send me the links".`;
    }
    deps.logger.info({ orderId: order.id, orderCode: bought.orderCode }, 'replacement link sent');
    return `replacement for ${order.orderNo} bought and sent to the buyer.`;
  }

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
      quantity: Math.max(order.quantity, items.length),
      links: items.map((i) => ({ number: i.idx + 1, link: i.activationLink as string })),
      mode: 'again',
      remaining: 0,
      facts: deps.facts,
    });
    for (const part of parts) await reply(ctx, { text: part.text, html: true });
  }

  // ------------------------------------------------------------ commands

  admin.command('admin', async (ctx) => {
    await reply(ctx, { text: 'admin panel', keyboard: PANEL });
  });
  admin.command('balance', async (ctx) => {
    await reply(ctx, { text: await balanceView() });
  });
  admin.command('stats', async (ctx) => {
    await reply(ctx, { text: await statsView() });
  });
  admin.command('allorders', async (ctx) => {
    await reply(ctx, { text: await ordersView() });
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
    const text = ctx.match.trim();
    if (!text) {
      await reply(ctx, { text: `offer line: "${await getOfferText(db)}"\nchange it with /offertext <text> (no dates).` });
      return;
    }
    await setOfferText(db, text.toLowerCase());
    await reply(ctx, { text: `offer line is now: "${await getOfferText(db)}"` });
  });

  // ------------------------------------------------------------ panel and order buttons

  admin.callbackQuery(/^ad:/, async (ctx) => {
    const [, kind = '', arg = ''] = ctx.callbackQuery.data.split(':');
    const chat = ctx.from.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    await port.answer(ctx.callbackQuery.id);

    if (kind === 'p') {
      const show = async (text: string, keyboard = BACK) => {
        if (messageId && (await port.edit(chat, messageId, { text, keyboard })) === 'ok') return;
        await port.send(chat, { text, keyboard });
      };
      if (arg === 'home') return show('admin panel', PANEL);
      if (arg === 'balance') return show(await balanceView());
      if (arg === 'stats') return show(await statsView());
      if (arg === 'orders') return show(await ordersView());
      if (arg === 'leads') return show(await leadsView());
      if (arg === 'offer') return show(`offer line: "${await getOfferText(db)}"\nchange it with /offertext <text> (no dates).`);
      if (arg === 'pause' || arg === 'resume') {
        await setPaused(db, arg === 'pause');
        return show(arg === 'pause' ? 'sales paused.' : 'sales are on again.');
      }
      return;
    }

    const [order] = await db.select().from(orders).where(eq(orders.id, arg));
    if (!order) return;
    if (kind === 'resend') await port.send(chat, { text: await resend(order) });
    if (kind === 'links') await linksToAdmin(ctx, order);
    if (kind === 'replace') await port.send(chat, { text: await replace(order, `q${ctx.callbackQuery.id}`) });
  });
}

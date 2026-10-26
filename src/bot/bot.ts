import { sql } from 'drizzle-orm';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AgentReply, ChatTurn } from '../agent/agent.js';
import {
  fallbackReply,
  menuButtons,
  paymentText,
  priceText,
  supportText,
  whatsappUrl,
  type Button,
  type FallbackFacts,
} from '../agent/fallback.js';
import { loadHistory, saveTurn } from '../agent/history.js';
import { naira, spokenDate } from '../agent/prompt.js';
import type { BuyerServices, PayButton, PaymentLinkResult, ToolContext } from '../agent/tools.js';
import { findPendingOrder } from '../services/orders.js';
import type { Logger } from '../util/logger.js';

export interface BotDeps {
  token: string;
  /** Skips getMe; for tests. */
  botInfo?: UserFromGetMe;
  db: Db;
  logger: Logger;
  services: BuyerServices;
  agent: (input: { history: ChatTurn[]; userText: string; ctx: ToolContext }) => Promise<AgentReply>;
  facts: FallbackFacts & { offerDeadline: string };
  /** Per user. Default 20 messages per 10 minutes (docs/ARCHITECTURE.md 5.1). */
  rateLimit?: { max: number; windowMs: number };
}

const MAX_USER_TEXT = 1_000;

export function keyboard(rows: Button[][]): InlineKeyboard {
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const button of row) {
      if ('url' in button) kb.url(button.text, button.url);
      else kb.text(button.text, button.callbackData);
    }
    if (i < rows.length - 1) kb.row();
  });
  return kb;
}

export function payKeyboard(button: PayButton): InlineKeyboard {
  return new InlineKeyboard().url('pay now', button.url);
}

export function createBot(deps: BotDeps): Bot {
  const { db, facts, services, logger } = deps;
  const bot = new Bot(deps.token, {
    client: { timeoutSeconds: 15 },
    ...(deps.botInfo && { botInfo: deps.botInfo }),
  });

  // Only private chats. Groups and channels are ignored.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    await next();
  });

  // Keep the users row fresh. Hearing from someone means they have not blocked us.
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      await db
        .insert(users)
        .values({ telegramId: ctx.from.id, username: ctx.from.username ?? null, firstName: ctx.from.first_name })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: {
            username: ctx.from.username ?? null,
            firstName: ctx.from.first_name,
            lastSeenAt: sql`now()`,
            blocked: false,
          },
        });
    }
    await next();
  });

  bot.use(rateLimiter(deps.rateLimit ?? { max: 20, windowMs: 10 * 60_000 }));

  const menu = () => keyboard(menuButtons(facts));

  bot.command('start', async (ctx) => {
    await ctx.reply(
      `hi${ctx.from?.first_name ? ` ${ctx.from.first_name.toLowerCase()}` : ''}! i sell google ai pro 18 month activation links (jio offer) for ${naira(facts.unitPriceNgn)} each. ` +
        `pay here, and the link comes to this chat automatically. ask me anything, or tap below.`,
      { reply_markup: menu() },
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        'just tell me what you need, or use:',
        '/buy 1 to buy one link (or /buy 3 for three)',
        '/status to see your orders and get your links again',
        '/cancel to cancel an unpaid order',
        `the offer closes ${spokenDate(facts.offerDeadline)}, so activate soon after buying.`,
        supportText(facts),
      ].join('\n'),
      { reply_markup: menu() },
    );
  });

  bot.command('buy', async (ctx) => {
    const quantity = ctx.match.trim() === '' ? 1 : Number(ctx.match.trim());
    await replyWithPayment(ctx, await services.createPaymentLink(ctx.from?.id ?? 0, quantity));
  });

  bot.command('cancel', async (ctx) => {
    const { cancelled } = await services.cancelPendingOrder(ctx.from?.id ?? 0);
    await ctx.reply(cancelled ? 'done, your unpaid order is cancelled.' : "you don't have an unpaid order.");
  });

  bot.command('status', async (ctx) => {
    const telegramId = ctx.from?.id ?? 0;
    const orders = await services.getMyOrders(telegramId);
    if (orders.length === 0) {
      await ctx.reply('you have no orders yet. send /buy to get a link.', { reply_markup: menu() });
      return;
    }
    const lines = orders.map((o) => {
      const date = new Date(o.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
      return `${date.toLowerCase()}: ${o.quantity} link${o.quantity === 1 ? '' : 's'}, ${naira(o.totalNgn)}, ${o.meaning}`;
    });
    const kb = new InlineKeyboard();
    const pending = await findPendingOrder(db, telegramId);
    if (pending?.checkoutUrl) kb.url('pay now', pending.checkoutUrl).row();
    const withLinks = orders.find((o) => o.status === 'delivered' || o.status === 'partial');
    if (withLinks) kb.text('send my links again', `resend:${withLinks.orderRef}`);
    await ctx.reply(['your recent orders:', ...lines].join('\n'), { reply_markup: kb });
  });

  bot.callbackQuery('buy:1', async (ctx) => {
    await ctx.answerCallbackQuery();
    await replyWithPayment(ctx, await services.createPaymentLink(ctx.from.id, 1));
  });

  bot.callbackQuery('price', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(priceText(facts), { reply_markup: menu() });
  });

  bot.callbackQuery('support', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(supportText(facts), {
      reply_markup: new InlineKeyboard().url('whatsapp support', whatsappUrl(facts.supportWhatsapp)),
    });
  });

  bot.callbackQuery(/^resend:([0-9a-f]{8})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const result = await services.resendMyLinks(ctx.from.id, ctx.match[1]);
    if ('error' in result) {
      const why =
        result.error === 'resend_limit_reached'
          ? `that order's links were already resent a few times. whatsapp ${facts.supportWhatsapp} if you still need them.`
          : `i couldn't resend those links. whatsapp ${facts.supportWhatsapp} and we'll help.`;
      await ctx.reply(why);
    }
  });

  bot.on('message:text', async (ctx) => {
    const telegramId = ctx.from.id;
    const userText = ctx.message.text.slice(0, MAX_USER_TEXT);
    if (userText.startsWith('/')) {
      await ctx.reply("i don't know that command. send /help to see what i can do.");
      return;
    }

    await ctx.replyWithChatAction('typing').catch(() => {});
    const toolCtx: ToolContext = { telegramId };
    let reply: AgentReply;
    try {
      reply = await deps.agent({ history: await loadHistory(db, telegramId), userText, ctx: toolCtx });
    } catch (err) {
      logger.error({ err, telegramId }, 'agent turn crashed; using the scripted fallback');
      reply = { text: '', failed: true, toolCalls: [], ...(toolCtx.payButton && { payButton: toolCtx.payButton }) };
    }

    let text = reply.text;
    let markup: InlineKeyboard | undefined;
    if (reply.payButton) {
      if (reply.failed) text = paymentText(reply.payButton);
      markup = payKeyboard(reply.payButton);
    } else if (reply.failed) {
      const scripted = fallbackReply(userText, facts);
      text = scripted.text;
      markup = keyboard(scripted.buttons);
    } else if (/\b(pay now|tap|button)\b/i.test(text)) {
      // The model talked about a button that does not exist; give them real ones.
      markup = menu();
    }

    await ctx.reply(text, {
      link_preview_options: { is_disabled: true },
      ...(markup && { reply_markup: markup }),
    });
    await saveTurn(db, telegramId, 'user', userText);
    await saveTurn(db, telegramId, 'assistant', text);
  });

  bot.on('message', async (ctx) => {
    await ctx.reply('i can only read text messages. tell me what you need, or send /help.');
  });

  bot.catch(({ error, ctx }) => {
    logger.error({ err: error, updateId: ctx.update.update_id }, 'bot handler failed');
  });

  async function replyWithPayment(ctx: Context, result: PaymentLinkResult): Promise<void> {
    if (result.ok) {
      const button = { orderId: result.orderId, url: result.checkoutUrl, quantity: result.quantity, totalNgn: result.totalNgn };
      await ctx.reply(paymentText(button), { reply_markup: payKeyboard(button) });
      return;
    }
    switch (result.error) {
      case 'pending_order_exists': {
        const what = result.quantity === 1 ? '1 link' : `${result.quantity} links`;
        const text = `you already have an unpaid order for ${what}, total ${naira(result.totalNgn)}. pay it below, or send /cancel to start over.`;
        await ctx.reply(
          text,
          result.checkoutUrl
            ? { reply_markup: payKeyboard({ orderId: result.orderId, url: result.checkoutUrl, quantity: result.quantity, totalNgn: result.totalNgn }) }
            : {},
        );
        return;
      }
      case 'not_enough_stock':
        await ctx.reply(
          result.maxQuantity > 0
            ? `i can only sell ${result.maxQuantity} right now. send /buy ${result.maxQuantity} to get them.`
            : `we're out of links right now. please check back soon, or whatsapp ${facts.supportWhatsapp}.`,
        );
        return;
      case 'invalid_quantity':
        await ctx.reply(`you can buy 1 to ${result.maxQuantity} links per order, for example /buy 3.`);
        return;
      case 'sales_paused':
        await ctx.reply('sales are paused for a moment. please check back shortly.');
        return;
      case 'sales_closed':
        await ctx.reply('sales have closed, the offer has ended. thank you!');
        return;
      case 'payment_link_failed':
        await ctx.reply("i couldn't create the payment link just now. please try again in a minute.");
        return;
    }
  }

  return bot;
}

/** Sends a message with a pay now button; used for the abandoned payment nudge. */
export function payButtonSender(bot: Bot) {
  return async (chatId: number, text: string, button: PayButton): Promise<void> => {
    await bot.api.sendMessage(chatId, text, { reply_markup: payKeyboard(button) });
  };
}

/** In memory, per process: fine for one instance. Warns once per window, then stays quiet. */
function rateLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const hits = new Map<number, number[]>();
  const warned = new Map<number, number>();
  return async (ctx: Context, next: () => Promise<void>) => {
    const id = ctx.from?.id;
    if (id === undefined) return next();
    const now = Date.now();
    const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(id, recent);
    if (recent.length <= max) return next();
    if (now - (warned.get(id) ?? 0) > windowMs) {
      warned.set(id, now);
      await ctx.reply("you're sending a lot of messages. give me a few minutes, then try again.").catch(() => {});
    }
  };
}

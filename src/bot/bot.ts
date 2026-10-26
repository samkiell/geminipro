import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { Bot, Context } from 'grammy';
import type { AgentReply } from '../agent/agent.js';
import { detectLang, noteLanguage, type Lang } from '../agent/buyer.js';
import { createPicker, isOwnerQuestion, isPurchaseRequest, quantityIn, scriptedTurn } from '../agent/fallback.js';
import { saveTurn } from '../agent/history.js';
import type { ToolContext } from '../agent/tools.js';
import type { HelpPage } from '../content/help.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { OWNER_LINKS, ownerButtons } from '../knowledge/owner.js';
import type { Notify } from '../services/notifier.js';
import { findOwnOrder, UNPAID_OPEN } from '../services/orders.js';
import type { Logger } from '../util/logger.js';
import type { Flows } from './flows.js';
import type { Keyboard, TelegramPort } from './telegram.js';
import { cb, STALE_BUTTON, type UiFacts } from './views.js';

// Buyer side of the bot: four commands (/start /buy /history /help), button taps, and free text
// for the agent. Anything visual goes through flows; this file only routes.

export interface BotDeps {
  db: Db;
  logger: Logger;
  port: TelegramPort;
  flows: Flows;
  facts: UiFacts;
  agent: {
    available: () => boolean;
    reply: (input: { userText: string; ctx: ToolContext }) => Promise<AgentReply>;
  };
  saveLead: (telegramId: number, username: string | undefined, summary: string) => Promise<'saved' | 'limited'>;
  /** Per user. Default 20 messages per 10 minutes (docs/ARCHITECTURE.md 5.1). */
  rateLimit?: { max: number; windowMs: number };
  /** Admin commands, registered before the buyer ones (they never reach non admins). */
  registerAdmin?: (bot: Bot) => void;
  /** Owner alerts; used here to report that the model is rate limited or down. */
  notify?: Notify;
}

const MAX_USER_TEXT = 1_000;
const HELP_PAGES = new Set<string>(['hub', 'how', 'get', 'activate', 'plan', 'policy', 'offer']);
const MENU: Keyboard = [
  [{ text: 'buy a link', data: cb.buy(1) }],
  [
    { text: 'my orders', data: cb.history(1) },
    { text: 'help', data: cb.help('hub') },
  ],
];

export function registerBot(bot: Bot, deps: BotDeps): void {
  const { db, port, flows, logger } = deps;
  const pickFor = createPicker();
  // Replies with buttons that stop meaning anything once the buyer moves on (Prompt A section 4).
  const ephemeral = new Map<number, number>();

  async function clearEphemeral(telegramId: number): Promise<void> {
    const messageId = ephemeral.get(telegramId);
    if (messageId === undefined) return;
    ephemeral.delete(telegramId);
    await port.setButtons(telegramId, messageId);
  }

  async function reply(telegramId: number, text: string, keyboard?: Keyboard): Promise<void> {
    const id = await port.send(telegramId, { text, ...(keyboard && { keyboard }) });
    if (keyboard) ephemeral.set(telegramId, id);
    if (ephemeral.size > 10_000) ephemeral.clear();
  }

  // Private chats only.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    await next();
  });

  // One update at a time per user, in order: double taps and quick messages never race.
  const chains = new Map<number, Promise<void>>();
  bot.use(async (ctx, next) => {
    const key = ctx.chat?.id;
    if (key === undefined) return next();
    const previous = chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const chain = previous.then(() => mine);
    chains.set(key, chain);
    await previous;
    try {
      await next();
    } finally {
      release();
      if (chains.get(key) === chain) chains.delete(key);
    }
  });

  // Keep the users row fresh. Hearing from someone means they have not blocked us.
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      await db
        .insert(users)
        .values({ telegramId: ctx.from.id, username: ctx.from.username ?? null, firstName: ctx.from.first_name })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: { username: ctx.from.username ?? null, firstName: ctx.from.first_name, lastSeenAt: sql`now()`, blocked: false },
        });
    }
    await next();
  });

  bot.use(rateLimiter(deps.rateLimit ?? { max: 20, windowMs: 10 * 60_000 }, port));

  deps.registerAdmin?.(bot);

  bot.command('start', async (ctx) => {
    await clearEphemeral(ctx.chat.id);
    await flows.showStart(ctx.chat.id, ctx.from?.first_name);
  });
  bot.command('buy', async (ctx) => {
    await clearEphemeral(ctx.chat.id);
    await flows.startBuy(ctx.chat.id, Number(ctx.match.trim()) || 1);
  });
  bot.command('history', async (ctx) => {
    await clearEphemeral(ctx.chat.id);
    await flows.showHistory(ctx.chat.id, 1);
  });
  bot.command('help', async (ctx) => {
    await clearEphemeral(ctx.chat.id);
    await flows.showHelp(ctx.chat.id, 'hub');
  });

  bot.on('callback_query:data', async (ctx) => {
    const telegramId = ctx.from.id;
    const queryId = ctx.callbackQuery.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const [kind = '', a = '', b = ''] = ctx.callbackQuery.data.split(':');

    const stale = async () => {
      await port.answer(queryId, STALE_BUTTON);
      if (messageId) await port.setButtons(telegramId, messageId);
    };
    // Ids in callback data are never trusted: the order must belong to whoever tapped.
    const owned = async (orderId: string) => findOwnOrder(db, telegramId, orderId);

    switch (kind) {
      case 'n':
        await port.answer(queryId);
        return;
      case 'b': {
        await port.answer(queryId);
        if (messageId && ephemeral.get(telegramId) === messageId) await clearEphemeral(telegramId);
        await flows.startBuy(telegramId, Number(a) || 1);
        return;
      }
      case 'q': {
        const order = await owned(a);
        if (!messageId || !order || !UNPAID_OPEN.includes(order.status) || order.summaryMessageId !== messageId) return stale();
        await port.answer(queryId);
        const result = await flows.changeQuantity(telegramId, messageId, a, Number(b));
        if (!result.ok && result.reason === 'stale' && messageId) await port.setButtons(telegramId, messageId);
        return;
      }
      case 'x': {
        const order = await owned(a);
        if (!order || !UNPAID_OPEN.includes(order.status)) return stale();
        await port.answer(queryId, 'cancelled');
        await flows.cancelFromCard(telegramId, a);
        return;
      }
      case 'h':
        await port.answer(queryId);
        await flows.showHistory(telegramId, Number(a) || 1, messageId);
        return;
      case 'o': {
        if (!(await owned(a))) return stale();
        await port.answer(queryId);
        await flows.showOrder(telegramId, a, Number(b) || 1, messageId);
        return;
      }
      case 'l': {
        if (!(await owned(a))) return stale();
        if (!flows.allowLinks(telegramId)) {
          await port.answer(queryId, 'too many taps, try again in a minute');
          return;
        }
        await port.answer(queryId);
        await flows.showLinks(telegramId, a);
        return;
      }
      case 'hp':
        if (!HELP_PAGES.has(a)) return stale();
        await port.answer(queryId);
        await flows.showHelp(telegramId, a as HelpPage | 'hub', messageId);
        return;
      case 'a': {
        const order = await owned(b);
        if (!messageId || !order || (a !== 'y' && a !== 'h')) return stale();
        await port.answer(queryId);
        await flows.answerActivation(telegramId, messageId, b, a === 'y' ? 'yes' : 'help', ctx.from.username);
        return;
      }
      case 'v': {
        // v:<itemId> asks to confirm, v:y:<itemId> closes the link, v:n:<itemId> backs out.
        const step = a === 'y' ? 'yes' : a === 'n' ? 'no' : 'ask';
        const itemId = step === 'ask' ? a : b;
        if (!messageId || !(await flows.activationTap(telegramId, messageId, itemId, step))) return stale();
        await port.answer(queryId, step === 'yes' ? 'marked activated ✅' : step === 'ask' ? 'this closes the link in this chat' : undefined);
        return;
      }
      default:
        await stale();
    }
  });

  bot.on('message:text', async (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username;
    const userText = ctx.message.text.slice(0, MAX_USER_TEXT);
    if (userText.startsWith('/')) {
      await port.send(telegramId, { text: "i don't know that command. try /buy, /history or /help." });
      return;
    }

    await clearEphemeral(telegramId);
    await noteLanguage(db, telegramId, userText);
    const lang = detectLang(userText) ?? (await storedLang(db, telegramId));

    const toolCtx: ToolContext = { telegramId, username, attachments: [] };
    let answer: AgentReply | undefined;
    if (deps.agent.available()) {
      await ctx.replyWithChatAction('typing').catch(() => {});
      try {
        answer = await deps.agent.reply({ userText, ctx: toolCtx });
      } catch (err) {
        logger.error({ err, telegramId }, 'agent turn crashed; answering with a scripted reply');
      }
    }

    let saved: string;
    if (answer && !answer.failed) {
      // A clear "i want to pay now" must end with the card, even if the model only quoted a price.
      if (!toolCtx.cardShown && isPurchaseRequest(userText)) {
        const outcome = await flows.startBuy(telegramId, quantityIn(userText) ?? 1);
        if (outcome.ok) toolCtx.cardShown = outcome;
      }
      // Questions about the maker always get his links, even when the model answered from memory.
      if (toolCtx.attachments.length === 0 && isOwnerQuestion(userText)) {
        toolCtx.attachments.push(ownerButtons('identity').map((name) => ({ text: name, url: OWNER_LINKS[name] })));
      }
      const keyboard = toolCtx.attachments.length > 0 ? toolCtx.attachments : undefined;
      // The model talked about a button that is not there: give them real ones.
      const phantom = !keyboard && !toolCtx.cardShown && /\b(tap|button|pay now)\b/i.test(answer.text);
      await reply(telegramId, answer.text, keyboard ?? (phantom ? MENU : undefined));
      saved = answer.text;
    } else {
      if (answer?.failure !== 'empty') {
        deps.notify?.({
          level: 'warning',
          title: 'groq unavailable, scripted replies in use',
          body: `The agent could not answer (${answer?.failure ?? 'no model free'}). Buyers get scripted replies and can still buy. On the free tier this usually clears within a minute.`,
          cooldownKey: 'groq',
        });
      }
      if (toolCtx.cardShown) {
        saved = "your order card is above. tap pay when you're ready.";
        await reply(telegramId, saved);
      } else {
        saved = await scripted(telegramId, username, userText, lang);
      }
    }

    await saveTurn(db, telegramId, 'user', userText);
    await saveTurn(db, telegramId, 'assistant', saved);
  });

  bot.on('message', async (ctx) => {
    await port.send(ctx.chat.id, { text: 'i can only read text messages. tell me what you need, or send /help.' });
  });

  bot.catch(({ error, ctx }) => {
    logger.error({ err: error, updateId: ctx.update.update_id }, 'bot handler failed');
  });

  /** Rate limited, busy or down model: act on what they asked anyway. Returns what to remember. */
  async function scripted(telegramId: number, username: string | undefined, userText: string, lang: Lang): Promise<string> {
    const action = scriptedTurn(userText, { lang, facts: deps.facts, pick: pickFor(telegramId) });
    switch (action.kind) {
      case 'buy':
        await flows.startBuy(telegramId, action.quantity);
        return `[showed the order card for ${action.quantity}]`;
      case 'history':
        await flows.showHistory(telegramId, 1);
        return '[showed their order history]';
      case 'order':
        if (!(await flows.showOrderByNo(telegramId, action.orderNo))) {
          await reply(telegramId, `i couldn't find order ${action.orderNo} on your account. tap below to see your orders.`, [
            [{ text: 'my orders', data: cb.history(1) }],
          ]);
        }
        return `[showed order ${action.orderNo}]`;
      case 'help':
        await flows.showHelp(telegramId, action.page);
        return `[showed help: ${action.page}]`;
      case 'cancel': {
        const text = (await flows.cancelPending(telegramId)) ? 'done, your unpaid order is cancelled.' : "you don't have an unpaid order.";
        await reply(telegramId, text);
        return text;
      }
      case 'lead':
        await deps.saveLead(telegramId, username, userText);
        await reply(telegramId, action.text, action.keyboard);
        return action.text;
      case 'reply':
        await reply(telegramId, action.text, action.keyboard);
        return action.text;
    }
  }
}

async function storedLang(db: Db, telegramId: number): Promise<Lang> {
  const [user] = await db.select({ lang: users.lang }).from(users).where(eq(users.telegramId, telegramId));
  return user?.lang ?? 'en';
}

/** In memory, per process: fine for one instance. Warns once per window, then stays quiet. */
function rateLimiter({ max, windowMs }: { max: number; windowMs: number }, port: TelegramPort) {
  const hits = new Map<number, number[]>();
  const warned = new Map<number, number>();
  return async (ctx: Context, next: () => Promise<void>) => {
    const id = ctx.from?.id;
    if (id === undefined) return next();
    const now = Date.now();
    const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(id, recent);
    if (hits.size > 50_000) hits.clear();
    if (recent.length <= max) return next();
    if (ctx.callbackQuery) await port.answer(ctx.callbackQuery.id, 'slow down a little, try again in a few minutes');
    if (now - (warned.get(id) ?? 0) > windowMs) {
      warned.set(id, now);
      await port.send(id, { text: "you're sending a lot of messages. give me a few minutes, then try again." }).catch(() => {});
    }
  };
}

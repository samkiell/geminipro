import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { Bot, Context } from 'grammy';
import type { BrainResult } from '../agent/brain.js';
import { detectLang, noteLanguage, type Lang } from '../agent/buyer.js';
import { createPicker } from '../agent/fallback.js';
import { fastPath } from '../agent/fastpath.js';
import { saveTurn } from '../agent/history.js';
import type { HelpPage } from '../content/help.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Notify } from '../services/notifier.js';
import { findOwnOrder, UNPAID_OPEN } from '../services/orders.js';
import { priceFor, type PricingConfig } from '../services/pricing.js';
import { attributeReferral, parseRefPayload } from '../services/referrals.js';
import type { Proof } from '../services/proof.js';
import type { Logger } from '../util/logger.js';
import type { Flows } from './flows.js';
import { createResponder } from './respond.js';
import type { Keyboard, TelegramPort } from './telegram.js';
import { priceView, STALE_BUTTON, type UiFacts } from './views.js';

// Buyer side of the bot: five commands (/start /buy /history /invite /help), button taps, and free text.
// Free text costs at most one model call: the fast path and the cache answer common messages for
// free, and the scripted fallback answers when no model is free. Visuals go through flows.

export interface BotDeps {
  db: Db;
  logger: Logger;
  port: TelegramPort;
  flows: Flows;
  facts: UiFacts;
  pricing: PricingConfig;
  /** One model decision per message (agent/brain.ts). */
  brain: { decide: (telegramId: number, userText: string) => Promise<BrainResult & { cached?: boolean }> };
  proof: Pick<Proof, 'send'>;
  saveLead: (telegramId: number, username: string | undefined, summary: string) => Promise<'saved' | 'limited'>;
  /** Counts free answers and scripted fallbacks (agent/usage.ts). */
  usage?: { free: () => void; fallback: (reason: string) => void };
  /** Per user. Default 20 messages per 10 minutes (docs/ARCHITECTURE.md 5.1). */
  rateLimit?: { max: number; windowMs: number };
  /** Never rate limited: the owner must always be able to run the shop. */
  adminIds?: readonly number[];
  /** Admin commands, registered before the buyer ones (they never reach non admins). */
  registerAdmin?: (bot: Bot) => void;
  /** Owner alerts (support requests). */
  notify?: Notify;
}

const MAX_USER_TEXT = 1_000;
const HELP_PAGES = new Set<string>(['hub', 'how', 'get', 'activate', 'plan', 'policy', 'offer']);

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

  const responder = createResponder({
    flows,
    facts: deps.facts,
    pricing: deps.pricing,
    proof: deps.proof,
    notify: deps.notify ?? (() => {}),
    saveLead: deps.saveLead,
    reply,
    pick: pickFor,
  });

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

  // Updates from users seen for the first time: only their /start may carry a referral.
  const firstContact = new WeakSet<Context>();

  // Keep the users row fresh. Hearing from someone means they have not blocked us.
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      const [row] = await db
        .insert(users)
        .values({ telegramId: ctx.from.id, username: ctx.from.username ?? null, firstName: ctx.from.first_name })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: { username: ctx.from.username ?? null, firstName: ctx.from.first_name, lastSeenAt: sql`now()`, blocked: false },
        })
        // xmax is 0 only for a freshly inserted row.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (row?.inserted) firstContact.add(ctx);
    }
    await next();
  });

  bot.use(rateLimiter(deps.rateLimit ?? { max: 20, windowMs: 10 * 60_000 }, port, deps.adminIds ?? []));

  deps.registerAdmin?.(bot);

  bot.command('start', async (ctx) => {
    await clearEphemeral(ctx.chat.id);
    const code = parseRefPayload(ctx.match);
    if (code) {
      const result = await attributeReferral(db, ctx.chat.id, code, firstContact.has(ctx));
      logger.info({ telegramId: ctx.chat.id, result }, 'referral start');
    }
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
  bot.command('invite', async (ctx) => {
    await clearEphemeral(ctx.chat.id);
    await flows.showInvite(ctx.chat.id);
  });
  // Unlisted, for everyone: the owner uses it to fill ADMIN_TELEGRAM_IDS.
  bot.command('myid', async (ctx) => {
    await port.send(ctx.chat.id, { text: `your telegram id: ${ctx.chat.id}` });
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
      case 'dq': {
        if (!messageId) return stale();
        const result = await flows.changeDraftQuantity(telegramId, messageId, Number(a));
        if (!result.ok && result.reason === 'stale') return stale();
        await port.answer(queryId);
        return;
      }
      case 'cp': {
        if (!messageId) return stale();
        const result = await flows.continueDraft(telegramId, messageId);
        if (!result.ok && result.reason === 'stale') return stale();
        await port.answer(queryId);
        return;
      }
      case 'cd': {
        if (!messageId) return stale();
        await port.answer(queryId, 'cancelled');
        await flows.cancelDraft(telegramId, messageId);
        return;
      }
      case 'gj': {
        if (!messageId) return stale();
        await flows.recheckGate(telegramId, messageId, queryId);
        return;
      }
      case 'x': {
        const order = await owned(a);
        if (!order || !UNPAID_OPEN.includes(order.status)) return stale();
        await port.answer(queryId, 'cancelled');
        await flows.cancelFromCard(telegramId, a, messageId);
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
      case 'pr': {
        await port.answer(queryId);
        const quantity = Math.min(Math.max(Number(a) || 1, 1), deps.facts.maxQtyPerOrder);
        const view = priceView(quantity, priceFor(quantity, deps.pricing).totalNgn, deps.facts);
        await reply(telegramId, view.text, view.keyboard);
        return;
      }
      case 'pf':
        await port.answer(queryId);
        await deps.proof.send(telegramId);
        return;
      case 'inv':
        // From a delivery message: a new message, so the links stay. From the help hub: edit it.
        await port.answer(queryId);
        await flows.showInvite(telegramId, a === 'e' ? messageId : undefined);
        return;
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
      await port.send(telegramId, { text: "i don't know that command. try /buy, /history, /invite or /help." });
      return;
    }

    await clearEphemeral(telegramId);
    await noteLanguage(db, telegramId, userText);
    const lang = detectLang(userText) ?? (await storedLang(db, telegramId));
    const turn = { telegramId, username, userText, lang };

    let saved: string;
    const fast = fastPath(userText, lang, pickFor(telegramId));
    if (fast) {
      deps.usage?.free();
      saved = await responder.act(turn, fast);
    } else {
      // Typing first, so the buyer sees the bot at work while the model thinks.
      await ctx.replyWithChatAction('typing').catch(() => {});
      let result: BrainResult | undefined;
      try {
        result = await deps.brain.decide(telegramId, userText);
      } catch (err) {
        logger.error({ err, telegramId }, 'model turn crashed; answering with a scripted reply');
      }
      if (result?.ok) {
        if ('cached' in result && result.cached) deps.usage?.free();
        saved = await responder.act(turn, result.decision);
      } else {
        deps.usage?.fallback(result?.failure ?? 'crashed');
        saved = await responder.scripted(turn);
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
}

async function storedLang(db: Db, telegramId: number): Promise<Lang> {
  const [user] = await db.select({ lang: users.lang }).from(users).where(eq(users.telegramId, telegramId));
  return user?.lang ?? 'en';
}

/** In memory, per process: fine for one instance. Warns once per window, then stays quiet.
 * Callbacks never count (Prompt D §1). Only free text counts. */
function rateLimiter({ max, windowMs }: { max: number; windowMs: number }, port: TelegramPort, exempt: readonly number[]) {
  const hits = new Map<number, number[]>();
  const warned = new Map<number, number>();
  return async (ctx: Context, next: () => Promise<void>) => {
    const id = ctx.from?.id;
    if (id === undefined) return next();
    // Callbacks never count toward the rate limit and never trigger the warning; admins never do.
    if (ctx.callbackQuery || exempt.includes(id)) return next();
    const now = Date.now();
    const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(id, recent);
    if (hits.size > 50_000) hits.clear();
    if (recent.length <= max) return next();
    // Rate limited: warn once per window, stay silent after that.
    if (now - (warned.get(id) ?? 0) > windowMs) {
      warned.set(id, now);
      await port.send(id, { text: "you're sending a lot of messages. give me a few minutes, then try again." }).catch(() => {});
    }
  };
}

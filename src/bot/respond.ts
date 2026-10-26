import type { Lang } from '../agent/buyer.js';
import type { Decision } from '../agent/decide.js';
import { fallbackButtons, isOwnerQuestion, isPurchaseRequest, scriptedTurn } from '../agent/fallback.js';
import { LEAD_REPLY, ORDER_NOT_FOUND, SUPPORT_REPLY } from '../content/replies.js';
import { OWNER_LINKS, ownerButtons, ownerInfo, type OwnerTopic } from '../knowledge/owner.js';
import type { Notify } from '../services/notifier.js';
import { priceFor, type PricingConfig } from '../services/pricing.js';
import type { Proof } from '../services/proof.js';
import type { Flows } from './flows.js';
import type { Keyboard } from './telegram.js';
import { cb, priceView, supportButton, type UiFacts } from './views.js';

// Carries out a decision (docs/ARCHITECTURE.md 5): from the model, the fast path, the cache or the
// scripted fallback. The model only names an intent; code shows the cards, prices, orders and
// links, always for the user in the update, and checks ownership on every order.

export interface Turn {
  telegramId: number;
  username: string | undefined;
  userText: string;
  lang: Lang;
}

export interface ResponderDeps {
  flows: Flows;
  facts: UiFacts;
  pricing: PricingConfig;
  proof: Pick<Proof, 'send'>;
  notify: Notify;
  saveLead: (telegramId: number, username: string | undefined, summary: string) => Promise<'saved' | 'limited'>;
  /** Sends a reply; buttons on it are retired when the buyer moves on. */
  reply: (telegramId: number, text: string, keyboard?: Keyboard) => Promise<void>;
  pick: (telegramId: number) => (options: readonly string[]) => string;
}

/** A chat reply that talks about buying, prices, proof or support gets the buttons for it. */
const ACTIONABLE = /\b(buy|price|cost|pay|order|link|proof|real|legit|support|whatsapp|help|tap)\b/;

/** Belt and braces: a clear "i want to pay now" ends with the card even if the model only chatted. */
export function effectiveIntent(d: Decision, userText: string): Decision['intent'] {
  return (d.intent === 'chat' || d.intent === 'price') && isPurchaseRequest(userText) ? 'buy' : d.intent;
}

export function createResponder(deps: ResponderDeps) {
  const { flows, facts } = deps;
  const clamp = (q: number | null) => Math.min(Math.max(Math.trunc(q ?? 1) || 1, 1), facts.maxQtyPerOrder);


  async function owner(turn: Turn, topic: OwnerTopic): Promise<string> {
    const buttons = ownerButtons(topic).map((name) => ({ text: name, url: OWNER_LINKS[name] }));
    const text = ownerInfo(topic);
    await deps.reply(turn.telegramId, text, buttons.length > 0 ? [buttons] : undefined);
    return text;
  }

  /** Runs the decision; returns what to remember as the bot's side of the conversation. */
  async function act(turn: Turn, d: Decision): Promise<string> {
    const id = turn.telegramId;
    switch (effectiveIntent(d, turn.userText)) {
      case 'buy': {
        // UI intent: show only the card. Drop the model's reply (one response per action §1).
        const quantity = clamp(d.quantity);
        await flows.startBuy(id, quantity);
        return `[showed the order card for ${quantity}]`;
      }
      case 'price': {
        // UI intent: show only the price card.
        const quantity = clamp(d.quantity);
        const view = priceView(quantity, priceFor(quantity, deps.pricing).totalNgn, facts);
        await deps.reply(id, view.text, view.keyboard);
        return view.text;
      }
      case 'history':
        // UI intent: show only the history.
        await flows.showHistory(id, 1);
        return '[showed their order history]';
      case 'show_order': {
        const orderNo = /(\d{3,7})/.exec(d.orderNo ?? turn.userText)?.[1];
        if (!orderNo) {
          await flows.showHistory(id, 1);
          return '[showed their order history]';
        }
        // findOwnOrderByNo inside: only this buyer's orders are ever shown.
        if (await flows.showOrderByNo(id, `GP-${orderNo}`)) return `[showed order GP-${orderNo}]`;
        const text = ORDER_NOT_FOUND(`GP-${orderNo}`);
        await deps.reply(id, text, [[{ text: 'my orders', data: cb.history(1) }]]);
        return text;
      }
      case 'proof':
        // Fixed, honest wording only: the model's reply is not used here.
        await deps.proof.send(id);
        return '[sent the proof screenshots]';
      case 'help':
        // UI intent: show only the help hub.
        await flows.showHelp(id, 'hub');
        return '[showed the help menu]';
      case 'support': {
        const text = SUPPORT_REPLY(facts.supportLocal);
        await deps.reply(id, text, [[supportButton(facts)]]);
        deps.notify({
          level: 'warning',
          title: 'buyer needs support',
          body: `${turn.username ? `@${turn.username}` : `Telegram user ${id}`}: ${turn.userText.slice(0, 300)}`,
        });
        return text;
      }
      case 'owner':
        return owner(turn, d.topic ?? 'identity');
      case 'shop':
        return owner(turn, 'shop');
      case 'lead': {
        await deps.saveLead(id, turn.username, d.summary ?? turn.userText.slice(0, 300));
        const text = d.reply || LEAD_REPLY;
        await deps.reply(id, text, [[{ text: 'portfolio', url: OWNER_LINKS.portfolio }]]);
        return text;
      }
      case 'chat': {
        // Questions about the maker always get his links, even when the model just chatted.
        if (isOwnerQuestion(turn.userText)) return owner(turn, 'identity');
        await deps.reply(id, d.reply, ACTIONABLE.test(d.reply) ? fallbackButtons(facts) : undefined);
        return d.reply;
      }
    }
  }

  /** No model: act on what they asked anyway (Prompt C section 5). */
  async function scripted(turn: Turn): Promise<string> {
    const action = scriptedTurn(turn.userText, { lang: turn.lang, facts, pick: deps.pick(turn.telegramId) });
    switch (action.kind) {
      case 'buy':
        await flows.startBuy(turn.telegramId, action.quantity);
        return `[showed the order card for ${action.quantity}]`;
      case 'history':
        await flows.showHistory(turn.telegramId, 1);
        return '[showed their order history]';
      case 'order':
        return act(turn, { intent: 'show_order', quantity: null, orderNo: action.orderNo, topic: null, summary: null, reply: '' });
      case 'help':
        await flows.showHelp(turn.telegramId, action.page);
        return `[showed help: ${action.page}]`;
      case 'proof':
        await deps.proof.send(turn.telegramId);
        return '[sent the proof screenshots]';
      case 'cancel': {
        const text = (await flows.cancelPending(turn.telegramId)) ? 'done, your unpaid order is cancelled.' : "you don't have an unpaid order.";
        await deps.reply(turn.telegramId, text);
        return text;
      }
      case 'lead':
        await deps.saveLead(turn.telegramId, turn.username, turn.userText);
        await deps.reply(turn.telegramId, action.text, action.keyboard);
        return action.text;
      case 'reply':
        await deps.reply(turn.telegramId, action.text, action.keyboard);
        return action.text;
    }
  }

  return { act, scripted };
}

export type Responder = ReturnType<typeof createResponder>;

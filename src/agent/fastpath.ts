import { GREETINGS } from '../content/replies.js';
import type { Lang } from './buyer.js';
import type { Decision } from './decide.js';

// Zero model calls for the most common messages (Prompt C section 4). Only whole, short messages
// match: "how much" is a price question, "i need 3, how much" is not and goes to the model. Code
// answers these from src/content/, so they cost nothing and never hit a rate limit.

/** Lowercase, curly quotes straightened, punctuation and emoji gone, spaces collapsed. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GREETING = /^(hi+|hello+|hey+|hy|hola|howdy|sup|yo|good (morning|afternoon|evening|day)|how far|wetin dey|how you dey|hi there|hello there|hey there)( (bot|boss|guy|bro|sis|sir|ma|there|samkiel))?$/;
const PRICE = /^(price|prices|the price|pricing|cost|how much|how much is it|how much e be|hw much|how much is one|how much for one|how much is a link|what's the price|whats the price|what is the price)$/;
const BUY_ONE = /^(buy|buy now|buy one|buy a link|buy link|i want|i want one|i want it|i want a link|i want to buy|i wanna buy|i need a link|i need one|i'll buy|i will buy|i wan buy|i go buy)$/;
const BUY_N = /^(?:buy|i want|i need) (\d{1,2})(?: links?)?$/;
const HISTORY = /^(history|my orders?|orders|order history|my links?|my link please|where is my link|where's my link|wheres my link|my receipt)$/;
const PROOF_WORDS = /\b(proof|real|legit|scam|scammer|trust|trusted|genuine|fake|original|does it work|is it working|is this working)\b/;
const HELP = /^(help|menu|options|commands|help me)$/;
const INVITE = /^(invite|refer|referral|referrals|my referral link|referral link|invite link|invite friends|refer a friend|earn|free link)$/;
const SUPPORT = /^(support|customer care|customer service|contact|contact support|whatsapp|agent|human|talk to a human|talk to someone|talk to a person)$/;

const decision = (intent: Decision['intent'], extra: Partial<Decision> = {}): Decision => ({
  intent,
  quantity: null,
  orderNo: null,
  topic: null,
  summary: null,
  reply: '',
  ...extra,
});

/**
 * A decision for messages code can answer alone, else undefined (ask the model). `pick` chooses
 * one wording so greetings vary.
 */
export function fastPath(text: string, lang: Lang, pick: (options: readonly string[]) => string): Decision | undefined {
  const t = normalize(text);
  if (!t) return undefined;
  if (GREETING.test(t)) return decision('chat', { reply: pick(GREETINGS[lang]) });
  if (PRICE.test(t)) return decision('price', { quantity: 1 });
  if (BUY_ONE.test(t)) return decision('buy', { quantity: 1 });
  const many = BUY_N.exec(t);
  if (many) return decision('buy', { quantity: Number(many[1]) });
  if (HISTORY.test(t)) return decision('history');
  if (HELP.test(t)) return decision('help');
  if (INVITE.test(t)) return decision('invite');
  if (SUPPORT.test(t)) return decision('support');
  // Doubt is a short question; a long message about it deserves the model.
  if (PROOF_WORDS.test(t) && t.split(' ').length <= 6) return decision('proof');
  return undefined;
}
